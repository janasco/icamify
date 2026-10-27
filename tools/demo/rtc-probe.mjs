#!/usr/bin/env node
/**
 * End-to-end WebRTC check against a running iCamify server.
 *
 * The probe is a headless browser: it opens the control socket, offers H.264,
 * applies the server's answer, and counts the RTP packets and keyframes that
 * actually arrive. That is the only honest way to prove the media plane works
 * without opening Chrome — a 200 from `/api/webrtc` proves nothing.
 *
 * Exit codes: 0 media arrived, 1 no media / negotiation failed, 2 WebRTC disabled.
 *
 * `node tools/demo/rtc-probe.mjs --camera front-door --seconds 6`
 */
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { WebSocket } from 'ws';
import { inspectH264Payload } from '../../packages/rtc/src/rtp.ts';

const options = parseArgs(process.argv.slice(2));
const baseUrl = (options.url ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const cameraId = options.camera ?? 'front-door';
const seconds = Number(options.seconds ?? 5);

const info = await fetchJson(`${baseUrl}/api/webrtc`);
if (info === null) {
  process.stderr.write(`cannot reach ${baseUrl}/api/webrtc — is the server running?\n`);
  process.exit(2);
}
process.stdout.write(
  `server: webrtc ${info.available ? 'available' : 'unavailable'} (engine ${info.engine ?? 'none'})` +
    `${info.reason === undefined ? '' : ` — ${info.reason}`}\n`,
);
if (info.available !== true) process.exit(2);

const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
const socket = new WebSocket(wsUrl);
const pending = new Map();

socket.on('message', (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(data.toString());
  if (message.type === 'webrtc:answer') pending.get('answer')?.(message);
  if (message.type === 'webrtc:error') pending.get('error')?.(message);
});

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

const codec = new RTCRtpCodecParameters({
  mimeType: 'video/H264',
  clockRate: 90_000,
  payloadType: Number(options.payloadType ?? 102),
  parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
});
const pc = new RTCPeerConnection({ codecs: { video: [codec] } });
const stats = { packets: 0, bytes: 0, keyframes: 0, parameterSets: 0, nalTypes: new Set(), firstPayloadType: undefined };
pc.onTrack.subscribe((track) => {
  track.onReceiveRtp.subscribe((packet) => {
    stats.packets += 1;
    stats.bytes += packet.payload.length;
    stats.firstPayloadType ??= packet.header.payloadType;
    const infoPayload = inspectH264Payload(packet.payload);
    if (infoPayload === undefined) return;
    stats.nalTypes.add(infoPayload.nalType);
    if (infoPayload.keyframe) stats.keyframes += 1;
    if (infoPayload.parameterSet) stats.parameterSets += 1;
  });
});

pc.addTransceiver('video', { direction: 'recvonly' });
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
process.stdout.write(`offering ${cameraId}: ${offer.sdp.split('\n').filter((line) => line.startsWith('a=rtpmap')).join(', ')}\n`);

const answer = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the server did not answer the offer')), 15_000);
  pending.set('answer', (message) => {
    clearTimeout(timer);
    resolve(message);
  });
  pending.set('error', (message) => {
    clearTimeout(timer);
    reject(new Error(`${message.code}: ${message.message}`));
  });
  socket.send(JSON.stringify({ type: 'webrtc:offer', cameraId, sdp: offer.sdp }));
});

process.stdout.write(
  `answer: ${answer.sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith('a=rtpmap') || line.startsWith('a=fmtp'))
    .join(' | ')}\n`,
);
await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

// Trickle our own candidates once ICE gathering finishes; the server accepts them
// per session, which is exactly what the browser player does.
for (const line of (pc.localDescription?.sdp ?? '').split(/\r?\n/)) {
  if (!line.startsWith('a=candidate:')) continue;
  socket.send(
    JSON.stringify({ type: 'webrtc:ice', sessionId: answer.sessionId, candidate: { candidate: line.slice(2), sdpMid: '0', sdpMLineIndex: 0 } }),
  );
}

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const status = await fetchJson(`${baseUrl}/api/webrtc`);
const session = status?.details?.sessions?.find((entry) => entry.sessionId === answer.sessionId);
const source = status?.details?.sources?.find((entry) => entry.cameraId === cameraId);

process.stdout.write(
  [
    `rtp:        ${stats.packets} packets, ${(stats.bytes / 1024).toFixed(0)} KiB, payload type ${stats.firstPayloadType ?? '?'}`,
    `h264:       ${stats.keyframes} keyframe packet(s), ${stats.parameterSets} parameter-set packet(s), NAL types ${[...stats.nalTypes].sort((a, b) => a - b).join(',') || 'none'}`,
    `connection: ${pc.connectionState}; server session ${session === undefined ? 'not listed' : `${session.state} (${session.packets} packets forwarded)`}`,
    `pipeline:   ${source === undefined ? 'not listed' : `${source.packets} packets, ${source.discontinuities} restart(s), ${source.viewers} viewer(s)`}`,
    `pipeline argv: ${(source?.argv ?? []).join(' ')}`,
  ].join('\n') + '\n',
);

socket.send(JSON.stringify({ type: 'webrtc:close', sessionId: answer.sessionId }));
socket.close();
await pc.close();

const ok = stats.packets > 0 && stats.parameterSets > 0;
process.stdout.write(ok ? 'RESULT: live video arrived over WebRTC\n' : 'RESULT: no usable video arrived\n');
process.exit(ok ? 0 : 1);

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) continue;
    result[flag.slice(2)] = next;
    index += 1;
  }
  return result;
}
