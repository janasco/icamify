/**
 * Just enough SDP to answer a browser offer.
 *
 * The engine does not try to be an SDP implementation: werift builds the answer.
 * What it needs from the offer is which H.264 payload type the browser expects
 * (an answer that renumbers it is what makes Chrome drop the track silently) and
 * the fmtp parameters that must be echoed back verbatim.
 */

export interface SdpCodec {
  payloadType: number;
  /** e.g. `H264`, `VP8`, lower-case-insensitive in the SDP. */
  encoding: string;
  clockRate: number;
  channels?: number;
  /** Parsed `a=fmtp` parameters, e.g. `{ 'packetization-mode': '1' }`. */
  fmtp: Record<string, string>;
  /** Raw room/rtcp-fb lines are ignored, but the raw fmtp string is kept. */
  fmtpLine?: string;
}

export interface SdpMediaSection {
  kind: 'video' | 'audio' | 'application' | 'unknown';
  port: number;
  protocol: string;
  formats: string[];
  mid?: string;
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  codecs: SdpCodec[];
  /** `a=setup:` value: actpass for a browser offer. */
  setup?: string;
  iceUfrag?: string;
}

const RTPMAP = /^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)(?:\/(\d+))?/;
const FMTP = /^a=fmtp:(\d+)\s+(.*)$/;

/** Splits an SDP body into its media sections. */
export function parseMediaSections(sdp: string): SdpMediaSection[] {
  const lines = sdp.replace(/\r\n/g, '\n').split('\n');
  const sections: SdpMediaSection[] = [];
  let current: SdpMediaSection | undefined;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(' ');
      const kind = parts[0];
      current = {
        kind: kind === 'video' || kind === 'audio' || kind === 'application' ? kind : 'unknown',
        port: Number(parts[1] ?? '0'),
        protocol: parts[2] ?? '',
        formats: parts.slice(3),
        direction: 'sendrecv',
        codecs: [],
      };
      sections.push(current);
      continue;
    }
    if (current === undefined) continue;

    if (line.startsWith('a=mid:')) {
      current.mid = line.slice(6).trim();
      continue;
    }
    if (line === 'a=sendonly' || line === 'a=recvonly' || line === 'a=sendrecv' || line === 'a=inactive') {
      current.direction = line.slice(2) as SdpMediaSection['direction'];
      continue;
    }
    if (line.startsWith('a=setup:')) {
      current.setup = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('a=ice-ufrag:')) {
      current.iceUfrag = line.slice(12).trim();
      continue;
    }
    const rtpmap = RTPMAP.exec(line);
    if (rtpmap !== null) {
      const payloadType = Number(rtpmap[1]);
      const channels = rtpmap[4] === undefined ? undefined : Number(rtpmap[4]);
      current.codecs.push({
        payloadType,
        encoding: (rtpmap[2] ?? '').toUpperCase(),
        clockRate: Number(rtpmap[3] ?? '0'),
        ...(channels === undefined ? {} : { channels }),
        fmtp: {},
      });
      continue;
    }
    const fmtp = FMTP.exec(line);
    if (fmtp !== null) {
      const payloadType = Number(fmtp[1]);
      const raw = (fmtp[2] ?? '').trim();
      const codec = current.codecs.find((candidate) => candidate.payloadType === payloadType);
      if (codec === undefined) continue;
      codec.fmtpLine = raw;
      for (const pair of raw.split(';')) {
        const [key, ...rest] = pair.split('=');
        const name = key?.trim();
        if (name === undefined || name.length === 0) continue;
        codec.fmtp[name] = rest.join('=').trim();
      }
    }
  }
  return sections;
}

export interface H264Selection {
  codec: SdpCodec;
  /** True when packetisation mode 1 (FU-A) was offered; the source uses it. */
  fuA: boolean;
  profileLevelId?: string;
}

/**
 * Picks the H.264 payload type to answer with.
 *
 * Browsers offer several H.264 entries (different profiles and packetisation
 * modes). The first one with packetisation mode 0 or 1 and a matching clock rate
 * is answered, preferring mode 1 because that is what FFmpeg's RTP muxer emits.
 */
export function selectH264(section: SdpMediaSection): H264Selection | undefined {
  const h264 = section.codecs.filter((codec) => codec.encoding === 'H264' && codec.clockRate === 90_000);
  if (h264.length === 0) return undefined;
  const ranked = [...h264].sort((left, right) => score(right) - score(left));
  const codec = ranked[0] as SdpCodec;
  const mode = codec.fmtp['packetization-mode'];
  return {
    codec,
    fuA: mode === undefined || mode === '1',
    ...(codec.fmtp['profile-level-id'] === undefined ? {} : { profileLevelId: codec.fmtp['profile-level-id'] }),
  };
}

function score(codec: SdpCodec): number {
  // Mode 1 first, then Constrained Baseline / Baseline profiles, which every
  // browser decodes in hardware on low-end devices.
  let total = 0;
  const mode = codec.fmtp['packetization-mode'];
  if (mode === undefined || mode === '1') total += 4;
  else if (mode === '0') total += 2;
  const profile = (codec.fmtp['profile-level-id'] ?? '').toLowerCase();
  if (profile.startsWith('42')) total += 3;
  else if (profile.startsWith('4d')) total += 2;
  else if (profile.startsWith('64')) total += 1;
  return total;
}

export interface AnswerCodec {
  mimeType: string;
  clockRate: number;
  payloadType: number;
  /**
   * Raw fmtp string, echoed verbatim from the offer. werift takes this as a
   * string, which is also the only form that guarantees a browser sees its own
   * profile-level-id back.
   */
  parameters?: string;
  /** Parsed fmtp values, used for logging and diagnostics. */
  fmtp: Record<string, string>;
}

/**
 * Builds the codec description for the answer. The browser's own fmtp values are
 * echoed back, because an answer that changes profile-level-id makes Firefox
 * refuse the track.
 */
export function answerCodecFor(selection: H264Selection): AnswerCodec {
  return {
    mimeType: 'video/H264',
    clockRate: 90_000,
    payloadType: selection.codec.payloadType,
    ...(selection.codec.fmtpLine === undefined ? {} : { parameters: selection.codec.fmtpLine }),
    fmtp: { ...selection.codec.fmtp },
  };
}

/** Human-readable reason when an offer cannot be answered. */
export function describeUnsupportedOffer(sections: SdpMediaSection[]): string {
  const video = sections.find((section) => section.kind === 'video');
  if (video === undefined) return 'The offer has no video section.';
  const encodings = [...new Set(video.codecs.map((codec) => codec.encoding))];
  if (encodings.length === 0) return 'The offer lists no video codecs.';
  return `The browser offered no H.264 video (offered: ${encodings.join(', ')}); the camera pipeline sends H.264 only.`;
}
