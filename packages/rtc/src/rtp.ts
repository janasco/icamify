/**
 * RTP plumbing for the WebRTC engine.
 *
 * FFmpeg does the H.264 packetisation (STAP-A and FU-A, packetisation mode 1) and
 * sends RTP to a loopback UDP port. This module does the two things a camera
 * restart makes unavoidable:
 *
 * - it rewrites sequence numbers and timestamps so a relaunched pipeline does not
 *   appear to the browser as a 4-billion-tick jump backwards (which Chrome treats
 *   as a broken stream and never recovers from);
 * - it exposes just enough of the payload to tell a keyframe from a delta frame,
 *   which is what makes the tests meaningful.
 *
 * SSRC and payload type are also rewritten, because every peer connection has its
 * own negotiated payload type and the source has no idea which one was chosen.
 */

export interface RtpHeaderInfo {
  version: number;
  padding: boolean;
  extension: boolean;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  /** Byte offset where the payload starts (12 + CSRCs + extension header). */
  payloadOffset: number;
  payloadLength: number;
}

const FIXED_HEADER_BYTES = 12;

/**
 * Parses the fixed RTP header. Returns undefined for anything that is not a
 * plausible RTP packet, so a stray datagram can never be forwarded to a peer.
 */
export function parseRtpHeader(packet: Buffer): RtpHeaderInfo | undefined {
  if (packet.length < FIXED_HEADER_BYTES) return undefined;
  const version = (packet[0] as number) >> 6;
  if (version !== 2) return undefined;
  const padding = ((packet[0] as number) & 0x20) !== 0;
  const extension = ((packet[0] as number) & 0x10) !== 0;
  const csrcCount = (packet[0] as number) & 0x0f;
  const marker = ((packet[1] as number) & 0x80) !== 0;
  const payloadType = (packet[1] as number) & 0x7f;

  let offset = FIXED_HEADER_BYTES + csrcCount * 4;
  if (offset > packet.length) return undefined;
  if (extension) {
    if (offset + 4 > packet.length) return undefined;
    const profile = packet.readUInt16BE(offset);
    // 0xBEDE is the one-byte form we could handle, but nothing here needs the
    // extensions, so any profile is skipped rather than interpreted.
    void profile;
    const words = packet.readUInt16BE(offset + 2);
    offset += 4 + words * 4;
    if (offset > packet.length) return undefined;
  }

  let payloadLength = packet.length - offset;
  if (padding) {
    const paddingBytes = packet[packet.length - 1] as number;
    if (paddingBytes === 0 || paddingBytes > payloadLength) return undefined;
    payloadLength -= paddingBytes;
  }

  return {
    version,
    padding,
    extension,
    marker,
    payloadType,
    sequenceNumber: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payloadOffset: offset,
    payloadLength,
  };
}

export interface RtpContinuityOptions {
  /** SSRC written into every outgoing packet. Defaults to a random one. */
  ssrc?: number;
  /** Payload type written into every outgoing packet. */
  payloadType: number;
  /** First outgoing sequence number. */
  initialSequence?: number;
  /** Timestamp advance used when the source restarts (3000 = 33 ms at 90 kHz). */
  discontinuityStep?: number;
  /** Sequence jump treated as a restart rather than reordering/loss. */
  maxForwardGap?: number;
  /**
   * A timestamp step backwards no larger than this (90 kHz ticks) is treated as a
   * late packet and dropped; larger backward jumps are pipeline restarts.
   */
  maxReorderTicks?: number;
}

/**
 * Rewrites one camera's RTP stream into a monotonic one.
 *
 * The class is deliberately per source, not per viewer: every peer connection of a
 * camera receives the exact same rewritten packets, so two viewers of one camera
 * cannot see different timestamps. werift applies the per-sender offsets on top.
 */
export class RtpContinuity {
  private readonly ssrc: number;
  private readonly payloadType: number;
  private readonly step: number;
  private readonly maxForwardGap: number;
  private readonly maxReorderTicks: number;

  private outSequence: number;
  private outTimestamp: number;
  private lastInSequence: number | undefined;
  private lastInTimestamp: number | undefined;

  packets = 0;
  bytes = 0;
  discontinuities = 0;
  dropped = 0;

  constructor(options: RtpContinuityOptions) {
    this.ssrc = (options.ssrc ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.payloadType = options.payloadType & 0x7f;
    this.outSequence = (options.initialSequence ?? Math.floor(Math.random() * 0xffff)) & 0xffff;
    this.outTimestamp = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.step = Math.max(1, options.discontinuityStep ?? 3000);
    this.maxForwardGap = Math.max(16, options.maxForwardGap ?? 3000);
    this.maxReorderTicks = Math.max(1, options.maxReorderTicks ?? 90_000);
  }

  /** Returns a copy of the packet with rewritten header, or undefined to drop it. */
  rewrite(packet: Buffer): Buffer | undefined {
    const header = parseRtpHeader(packet);
    if (header === undefined || header.payloadLength === 0) {
      this.dropped += 1;
      return undefined;
    }

    if (this.lastInSequence === undefined || this.lastInTimestamp === undefined) {
      this.lastInSequence = header.sequenceNumber;
      this.lastInTimestamp = header.timestamp;
    } else {
      const sequenceDelta = (header.sequenceNumber - this.lastInSequence + 0x10000) & 0xffff;
      const timestampDelta = (header.timestamp - this.lastInTimestamp) | 0;

      if (sequenceDelta === 0) {
        // A duplicate from the socket; forwarding it would confuse the jitter buffer.
        this.dropped += 1;
        return undefined;
      }
      if (timestampDelta < 0) {
        if (-timestampDelta <= this.maxReorderTicks) {
          // A late packet: keeping it would move the output clock backwards, which
          // no decoder accepts. Dropping a reordered frame costs one frame.
          this.dropped += 1;
          return undefined;
        }
        // A restart: new pipeline, new SSRC, timestamps back at zero. Continue from
        // where the browser was, one frame later, or Chrome never decodes again.
        this.discontinuities += 1;
        this.outSequence = (this.outSequence + 1) & 0xffff;
        this.outTimestamp = (this.outTimestamp + this.step) >>> 0;
      } else {
        // Includes strong reordering and packet loss: the timestamp always moves
        // forward, and a huge sequence jump is collapsed to a single step so the
        // receiver's jitter buffer is not asked to wait for 3000 missing packets.
        this.outSequence = (this.outSequence + (sequenceDelta > this.maxForwardGap ? 1 : sequenceDelta)) & 0xffff;
        this.outTimestamp = (this.outTimestamp + timestampDelta) >>> 0;
      }
      this.lastInSequence = header.sequenceNumber;
      this.lastInTimestamp = header.timestamp;
    }

    const output = Buffer.from(packet);
    output[1] = (header.marker ? 0x80 : 0x00) | this.payloadType;
    output.writeUInt16BE(this.outSequence, 2);
    output.writeUInt32BE(this.outTimestamp, 4);
    output.writeUInt32BE(this.ssrc, 8);

    this.packets += 1;
    this.bytes += packet.length;
    return output;
  }

  stats(): {
    packets: number;
    bytes: number;
    discontinuities: number;
    dropped: number;
    ssrc: number;
    payloadType: number;
  } {
    return {
      packets: this.packets,
      bytes: this.bytes,
      discontinuities: this.discontinuities,
      dropped: this.dropped,
      ssrc: this.ssrc,
      payloadType: this.payloadType,
    };
  }
}

export interface H264PayloadInfo {
  /** H.264 NAL unit type of the frame this packet belongs to. */
  nalType: number;
  /** Single NAL, STAP-A aggregation or FU-A fragment. */
  packetization: 'single' | 'stap-a' | 'fu-a' | 'other';
  /** True for an IDR slice (type 5) or a keyframe aggregated in a STAP-A. */
  keyframe: boolean;
  /** True when the packet carries SPS (7) or PPS (8). */
  parameterSet: boolean;
}

/**
 * Reads the NAL type out of an RTP payload. Used by diagnostics and tests: the
 * engine itself never inspects the payload, it only forwards it.
 */
export function inspectH264Payload(payload: Buffer): H264PayloadInfo | undefined {
  if (payload.length === 0) return undefined;
  const first = payload[0] as number;
  if ((first & 0x80) !== 0) return undefined; // forbidden bit set
  const type = first & 0x1f;

  if (type === 24) {
    // STAP-A: one or more NAL units, each prefixed with a 16-bit length.
    let offset = 1;
    let keyframe = false;
    let parameterSet = false;
    while (offset + 2 <= payload.length) {
      const length = payload.readUInt16BE(offset);
      offset += 2;
      if (length === 0 || offset + length > payload.length) break;
      const nalType = (payload[offset] as number) & 0x1f;
      if (nalType === 5) keyframe = true;
      if (nalType === 7 || nalType === 8) parameterSet = true;
      offset += length;
    }
    return { nalType: type, packetization: 'stap-a', keyframe, parameterSet };
  }

  if (type === 28) {
    // FU-A: the real NAL type lives in the fragment header's low five bits.
    if (payload.length < 2) return undefined;
    const realType = (payload[1] as number) & 0x1f;
    return {
      nalType: realType,
      packetization: 'fu-a',
      keyframe: realType === 5,
      parameterSet: realType === 7 || realType === 8,
    };
  }

  const single = type >= 1 && type <= 23;
  return {
    nalType: type,
    packetization: single ? 'single' : 'other',
    keyframe: type === 5,
    parameterSet: type === 7 || type === 8,
  };
}
