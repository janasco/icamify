import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MediaError,
  buildDetectArgs,
  buildInputArgs,
  buildLiveArgs,
  buildProbeArgs,
  buildRecordArgs,
  buildSnapshotArgs,
  maskUrl,
  ProgressParser,
  redactArgv,
  selectVideoEncoder,
} from '../src/index.ts';
import type { StreamProfile, StreamSource } from '@icamify/core';

const rtsp: StreamSource = {
  type: 'rtsp',
  url: 'rtsp://192.168.1.50:554/Streaming/Channels/101',
  credentials: { username: 'admin', password: 'p@ss:word' },
};

const subStream: StreamSource = {
  type: 'rtsp',
  url: 'rtsp://192.168.1.50:554/Streaming/Channels/102',
  transport: 'tcp',
};

const copyProfile: StreamProfile = {
  copy: true,
  video: { codec: 'copy' },
  audio: { codec: 'copy' },
  container: 'mkv',
};

const liveProfile: StreamProfile = {
  video: {
    codec: 'h264',
    width: 1280,
    height: 720,
    fps: 25,
    bitrateKbps: 1500,
    maxBitrateKbps: 2000,
    gopSeconds: 1,
    preset: 'veryfast',
    profile: 'main',
    pixelFormat: 'yuv420p',
    rotation: 90,
  },
  audio: { codec: 'aac', bitrateKbps: 64 },
  latency: 'low',
};

function argsOf(result: { args: string[] }): string[] {
  return result.args;
}

function indexOfValue(args: string[], flag: string): number {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `expected ${flag} in ${args.join(' ')}`);
  return index;
}

describe('input args', () => {
  test('rtsp defaults to TCP and carries a socket timeout', () => {
    const result = buildInputArgs({ type: 'rtsp', url: rtsp.url, timeoutSeconds: 12 });
    assert.deepEqual(argsOf(result), ['-rtsp_transport', 'tcp', '-timeout', '12000000', '-i', rtsp.url]);
  });

  test('rtsp explicit UDP is honoured but warned about', () => {
    const result = buildInputArgs({ type: 'rtsp', url: rtsp.url, transport: 'udp' });
    assert.equal(result.args[1], 'udp');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /UDP RTSP transport/);
  });

  test('credentials are injected as URL userinfo and never printed in the clear', () => {
    const result = buildInputArgs(rtsp);
    assert.equal(result.target, 'rtsp://admin:p%40ss%3Aword@192.168.1.50:554/Streaming/Channels/101');
    const redacted = redactArgv(result.args);
    const joined = redacted.join(' ');
    assert.ok(!joined.includes('p%40ss'), `credentials leaked: ${joined}`);
    assert.match(joined, /rtsp:\/\/\*\*\*:\*\*\*@192\.168\.1\.50/);
  });

  test('maskUrl hides token query parameters', () => {
    assert.equal(maskUrl('https://cam.local/snapshot?token=abc123&width=640'), 'https://cam.local/snapshot?token=***&width=640');
  });

  test('http sources reconnect and declare the container format', () => {
    const result = buildInputArgs({
      type: 'http',
      url: 'http://cam.local/video.mjpg',
      format: 'mjpeg',
      auth: 'digest',
      credentials: { username: 'u', password: 'p' },
    });
    assert.ok(result.args.includes('-reconnect_streamed'));
    assert.equal(result.args[indexOfValue(result.args, '-f') + 1], 'mjpeg');
    assert.equal(result.args[indexOfValue(result.args, '-auth_type') + 1], 'digest');
  });

  test('onvif without a resolved stream URI is a configuration error', () => {
    assert.throws(
      () => buildInputArgs({ type: 'onvif', host: '10.0.0.9' }),
      (error: unknown) =>
        error instanceof MediaError && error.code === 'unsupported-source' && /ONVIF/.test(error.message),
    );
  });

  test('onvif uses the resolved URI over TCP', () => {
    const result = buildInputArgs({ type: 'onvif', host: '10.0.0.9' }, { resolvedUri: rtsp.url });
    assert.equal(result.args[1], 'tcp');
    assert.equal(result.args.at(-1), rtsp.url);
  });

  test('usb capture sets format, rate and size', () => {
    const result = buildInputArgs({
      type: 'usb',
      device: '/dev/video2',
      inputFormat: 'v4l2',
      resolution: { width: 1280, height: 720 },
      fps: 30,
    });
    assert.deepEqual(result.args, [
      '-f',
      'v4l2',
      '-framerate',
      '30',
      '-video_size',
      '1280x720',
      '-i',
      '/dev/video2',
    ]);
    assert.equal(result.warnings.length, 1);
  });

  test('file sources honour loop, realtime and seek', () => {
    const result = buildInputArgs({ type: 'file', path: './clip.mp4', loop: true, startSeconds: 30 });
    assert.deepEqual(result.args, ['-re', '-stream_loop', '-1', '-ss', '30', '-i', './clip.mp4']);
  });

  test('rtsp scheme mismatch is rejected rather than silently failing in FFmpeg', () => {
    assert.throws(
      () => buildInputArgs({ type: 'rtsp', url: 'http://cam.local/stream' }),
      (error: unknown) => error instanceof MediaError && error.code === 'invalid-argument',
    );
  });
});

describe('recording args', () => {
  test('copy profile is a pure remux with no encoder', () => {
    const result = buildRecordArgs({
      source: rtsp,
      profile: copyProfile,
      outputTemplate: '/data/rec/cam1/%Y%m%d-%H%M%S.mkv',
      segmentSeconds: 300,
      includeAudio: true,
    });
    const args = result.args;
    assert.deepEqual(
      args.slice(indexOfValue(args, '-c:v'), indexOfValue(args, '-c:v') + 2),
      ['-c:v', 'copy'],
    );
    assert.ok(!args.some((arg) => arg.startsWith('libx')), `unexpected encoder in ${args.join(' ')}`);
    assert.ok(args.includes('-f') && args.includes('segment'));
    assert.equal(args[indexOfValue(args, '-segment_time') + 1], '300');
    assert.equal(args[indexOfValue(args, '-segment_format') + 1], 'matroska');
    assert.ok(args.includes('%Y%m%d-%H%M%S') || args.some((a) => a.includes('%Y%m%d')));
    assert.equal(result.warnings.length, 0);
  });

  test('copy to MP4 warns about losing the file on a hard kill', () => {
    const result = buildRecordArgs({
      source: rtsp,
      profile: { ...copyProfile, container: 'mp4' },
      outputTemplate: '/data/rec/cam1/%Y%m%d-%H%M%S.mp4',
    });
    assert.match(result.warnings.join('\n'), /moov atom/);
  });

  test('progress output is opt-in', () => {
    const without = buildRecordArgs({
      source: rtsp,
      profile: copyProfile,
      outputTemplate: '/tmp/%Y.mkv',
    });
    assert.ok(!without.args.includes('-progress'));

    const withProgress = buildRecordArgs({
      source: rtsp,
      profile: copyProfile,
      outputTemplate: '/tmp/%Y.mkv',
      progress: true,
    });
    assert.ok(withProgress.args.includes('-progress'));
    assert.equal(withProgress.args[indexOfValue(withProgress.args, '-progress') + 1], 'pipe:1');
  });

  test('transcode recording selects a software encoder when no hardware is reported', () => {
    const result = buildRecordArgs({
      source: rtsp,
      profile: { ...liveProfile, container: 'mkv' },
      outputTemplate: '/tmp/%Y.mkv',
      hasEncoder: (name) => name === 'libx264',
    });
    const encoder = result.args[indexOfValue(result.args, '-c:v') + 1];
    assert.equal(encoder, 'libx264');
    assert.ok(result.args.includes('-preset'));
  });
});

describe('live args', () => {
  test('fragmented MP4 on stdout with low-latency flags', () => {
    const result = buildLiveArgs({ source: subStream, profile: liveProfile, output: 'fmp4', segmentDurationMs: 500 });
    const args = result.args;
    assert.equal(args.at(-1), 'pipe:1');
    assert.equal(args[indexOfValue(args, '-f') + 1], 'mp4');
    const movflags = args[indexOfValue(args, '-movflags') + 1] ?? '';
    assert.match(movflags, /frag_keyframe/);
    assert.match(movflags, /empty_moov/);
    assert.equal(args[indexOfValue(args, '-frag_duration') + 1], '500000');
    assert.ok(args.includes('-tune') && args.includes('zerolatency'));
    const filter = args[indexOfValue(args, '-vf') + 1] ?? '';
    assert.match(filter, /scale=1280:720/);
    assert.match(filter, /transpose=1/);
    assert.equal(args[indexOfValue(args, '-g') + 1], '25');
  });

  test('rtp egress passes an H.264 camera through and fixes the parameter sets', () => {
    const result = buildLiveArgs({
      source: subStream,
      profile: { ...liveProfile, video: { ...liveProfile.video, codec: 'h264', rotation: 0 } },
      output: 'rtp',
      rtp: { port: 42000, payloadType: 96 },
    });
    const args = result.args;
    assert.equal(args[indexOfValue(args, '-c:v') + 1], 'copy');
    // Without this a browser joining after the first IDR never decodes a frame.
    assert.equal(args[indexOfValue(args, '-bsf:v') + 1], 'h264_mp4toannexb');
    assert.equal(args[indexOfValue(args, '-f') + 1], 'rtp');
    assert.equal(args[indexOfValue(args, '-payload_type') + 1], '96');
    assert.equal(args.at(-1), 'rtp://127.0.0.1:42000');
    assert.ok(args.includes('-an'));
    assert.equal(result.warnings.some((warning) => /Scaling is ignored/.test(warning)), true);
  });

  test('rtp egress re-encodes a non-H.264 camera to H.264', () => {
    const h265: StreamProfile = { ...liveProfile, video: { ...liveProfile.video, codec: 'h265', rotation: 0 } };
    const result = buildLiveArgs({
      source: subStream,
      profile: h265,
      output: 'rtp',
      rtp: { port: 42001, payloadType: 102, maxBitrateKbps: 2500 },
    });
    const args = result.args;
    assert.equal(args[indexOfValue(args, '-c:v') + 1], 'libx264');
    assert.equal(args[indexOfValue(args, '-maxrate') + 1], '2500k');
    assert.ok(args.includes('-tune') && args.includes('zerolatency'));
    const filter = args[indexOfValue(args, '-vf') + 1] ?? '';
    assert.match(filter, /scale=1280:720/);
    assert.equal(result.warnings.some((warning) => /re-encoded to H\.264/.test(warning)), true);
  });

  test('rtp egress honours a forced transcode and the packet size', () => {
    const result = buildLiveArgs({
      source: subStream,
      profile: { ...liveProfile, video: { ...liveProfile.video, rotation: 0 } },
      output: 'rtp',
      rtp: { port: 43000, payloadType: 96, transcode: true, maxPacketSize: 900 },
    });
    assert.notEqual(result.args[indexOfValue(result.args, '-c:v') + 1], 'copy');
    assert.equal(result.args[indexOfValue(result.args, '-pkt_size') + 1], '900');
  });

  test('rtp egress refuses to start without a port', () => {
    assert.throws(
      () => buildLiveArgs({ source: subStream, profile: liveProfile, output: 'rtp' }),
      (error: unknown) => error instanceof MediaError && /RTP live output/.test(error.message),
    );
  });

  test('mjpeg fallback has no audio and no fragments', () => {
    const result = buildLiveArgs({
      source: subStream,
      profile: { ...liveProfile, video: { ...liveProfile.video, rotation: 0, width: 640, height: 360 } },
      output: 'mjpeg',
    });
    const args = result.args;
    assert.equal(args[indexOfValue(args, '-c:v') + 1], 'mjpeg');
    assert.ok(args.includes('-an'));
    assert.equal(args.at(-1), 'pipe:1');
  });

  test('nvenc is preferred when the build provides it', () => {
    const choice = selectVideoEncoder(
      { ...liveProfile.video, hardwareAcceleration: 'nvenc' },
      (name) => name === 'libx264' || name === 'h264_nvenc',
    );
    assert.equal(choice.encoder, 'h264_nvenc');
    assert.deepEqual(choice.warnings, []);
  });

  test('a missing hardware encoder falls back loudly instead of failing', () => {
    const choice = selectVideoEncoder({ ...liveProfile.video, hardwareAcceleration: 'nvenc' }, (name) => name === 'libx264');
    assert.equal(choice.encoder, 'libx264');
    assert.match(choice.warnings.join('\n'), /falling back to the software encoder/);
  });

  test('copy codec cannot be used for live view', () => {
    assert.throws(
      () => selectVideoEncoder({ codec: 'copy' }),
      (error: unknown) => error instanceof MediaError && error.code === 'invalid-argument',
    );
  });
});

describe('detect and snapshot args', () => {
  test('detect emits fixed-size gray raw frames', () => {
    const result = buildDetectArgs({ source: subStream, fps: 5, width: 320, height: 240 });
    const args = result.args;
    const filter = args[indexOfValue(args, '-vf') + 1] ?? '';
    assert.equal(filter, 'fps=5,scale=320:240,format=gray');
    assert.equal(args[indexOfValue(args, '-f') + 1], 'rawvideo');
    assert.equal(args[indexOfValue(args, '-pix_fmt') + 1], 'gray');
    assert.equal(args.at(-1), 'pipe:1');
  });

  test('snapshot grabs one scaled JPEG', () => {
    const result = buildSnapshotArgs({ source: rtsp, maxWidth: 640 });
    const args = result.args;
    assert.equal(args[indexOfValue(args, '-frames:v') + 1], '1');
    assert.equal(args[indexOfValue(args, '-vf') + 1], 'scale=640:-2');
    assert.equal(args[indexOfValue(args, '-f') + 1], 'mjpeg');
  });

  test('snapshot crops to a normalized rectangle before scaling', () => {
    const result = buildSnapshotArgs({
      source: rtsp,
      maxWidth: 640,
      crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    });
    const filter = result.args[indexOfValue(result.args, '-vf') + 1] ?? '';
    assert.equal(filter, 'crop=in_w*0.5:in_h*0.25:in_w*0.25:in_h*0.5,scale=640:-2');
    assert.deepEqual(result.warnings, []);
  });

  test('snapshot ignores an unusable crop and says so', () => {
    const result = buildSnapshotArgs({ source: rtsp, crop: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 } });
    // The rectangle is clipped to the frame, so a tenth of it remains: usable.
    assert.equal(
      result.args[indexOfValue(result.args, '-vf') + 1],
      'crop=in_w*0.1:in_h*0.1:in_w*0.9:in_h*0.9',
    );

    const empty = buildSnapshotArgs({ source: rtsp, crop: { x: 1, y: 1, width: 0.5, height: 0.5 } });
    assert.equal(empty.args.includes('-vf'), false);
    assert.equal(empty.warnings.length, 1);
  });

  test('probe targets the resolved URL with the JSON reader', () => {
    const result = buildProbeArgs(rtsp);
    assert.ok(result.args.includes('-print_format'));
    assert.equal(result.args.at(-1), buildInputArgs(rtsp).target);
  });
});

describe('progress parsing', () => {
  test('frames are emitted at the terminator, not per line', () => {
    const parser = new ProgressParser();
    assert.deepEqual(parser.push('frame=12\nfps=25.0\n'), []);
    const frames = parser.push('bitrate=1500.0kbits/s\nout_time_us=4000000\ntotal_size=750000\nspeed=1.02x\nprogress=continue\n');
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], {
      frame: 12,
      fps: 25,
      bitrateKbps: 1500,
      outTimeMs: 4000,
      totalSizeBytes: 750000,
      speed: 1.02,
    });
  });

  test('partial writes across chunks are buffered', () => {
    const parser = new ProgressParser();
    const first = parser.push('out_time_us=1000000\nprogress=cont');
    assert.deepEqual(first, []);
    const second = parser.push('inue\n');
    assert.equal(second.length, 1);
    assert.equal(second[0]?.outTimeMs, 1000);
  });
});

describe('source typing', () => {
  test('every source type is accepted by the input builder', () => {
    const sources: StreamSource[] = [
      { type: 'rtsp', url: 'rtsp://host/1' },
      { type: 'rtmp', url: 'rtmp://host/live/1' },
      { type: 'http', url: 'http://host/1' },
      { type: 'usb', device: '/dev/video0' },
      { type: 'file', path: './x.mp4' },
    ];
    for (const source of sources) {
      assert.ok(buildInputArgs(source).args.includes('-i'), `${source.type} produced no input`);
    }
  });
});
