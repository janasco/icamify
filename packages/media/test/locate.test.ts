import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MediaError,
  describeToolchain,
  locateFfmpeg,
  parseFfmpegVersion,
  versionAtLeast,
  type ToolRunner,
  type ToolRunResult,
} from '../src/index.ts';

/**
 * Real FFmpeg output excerpts. Keeping them verbatim means the parsers are
 * checked against the format operators actually see, not a convenient fiction.
 */
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/MPEG-4 AVC (VAAPI) (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const FILTERS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
 TSC scale            V->V       Scale the input video size and/or convert the image format.
 ..C transpose        V->V       Transpose input video.
`;

const DEMUXERS = `Formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ..d = Is a device
 ---
 D   3dostr          3DO STR
 D   flv             FLV (Flash Video)
 D   mjpeg           MJPEG video
 D   rtsp            RTSP input
  E  webm            WebM
`;

const MUXERS = `File formats:
 D. = Demuxing supported
 .E = Muxing supported
 --
  E  3g2             3GP2 (3GPP2 file format)
 D.  aac             raw ADTS AAC (Advanced Audio Coding)
 DE  matroska        Matroska
 DE  mp4             MP4 (MPEG-4 Part 14)
`;

const PROTOCOLS = `Supported file protocols:
Input:
  file
  http
  rtmp
  rtsp
Output:
  file
  rtmp
`;

const HWACCELS = `Hardware acceleration methods:
cuda
vaapi
`;

interface RunnerScript {
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  missing?: boolean;
  encoders?: string;
}

function scriptedRunner(script: RunnerScript = {}): ToolRunner {
  return async (bin, args): Promise<ToolRunResult> => {
    if (script.missing === true) {
      return { code: 127, stdout: '', stderr: 'not found', spawnFailed: true };
    }
    const version = bin.includes('ffprobe')
      ? (script.ffprobeVersion ?? 'ffprobe version 6.1.1 Copyright (c) 2007-2023')
      : (script.ffmpegVersion ?? 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023');
    if (args.includes('-version')) return { code: 0, stdout: version, stderr: '', spawnFailed: false };
    if (args.includes('-encoders')) {
      return { code: 0, stdout: script.encoders ?? ENCODERS, stderr: '', spawnFailed: false };
    }
    if (args.includes('-filters')) return { code: 0, stdout: FILTERS, stderr: '', spawnFailed: false };
    if (args.includes('-demuxers')) return { code: 0, stdout: DEMUXERS, stderr: '', spawnFailed: false };
    if (args.includes('-muxers')) return { code: 0, stdout: MUXERS, stderr: '', spawnFailed: false };
    if (args.includes('-protocols')) return { code: 0, stdout: PROTOCOLS, stderr: '', spawnFailed: false };
    if (args.includes('-hwaccels')) return { code: 0, stdout: HWACCELS, stderr: '', spawnFailed: false };
    return { code: 1, stdout: '', stderr: `unexpected args: ${args.join(' ')}`, spawnFailed: false };
  };
}

describe('version parsing', () => {
  test('reads a distro build string', () => {
    const version = parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers');
    assert.deepEqual(
      { major: version?.major, minor: version?.minor, patch: version?.patch },
      { major: 6, minor: 1, patch: 1 },
    );
  });

  test('reads a git-style version', () => {
    const version = parseFfmpegVersion('ffmpeg version n7.0-latest-win64-gpl');
    assert.equal(version?.major, 7);
    assert.equal(versionAtLeast(version!, 7), true);
    assert.equal(versionAtLeast(version!, 7, 1), false);
  });

  test('returns undefined for unrelated output', () => {
    assert.equal(parseFfmpegVersion('command not found'), undefined);
  });
});

describe('locateFfmpeg', () => {
  test('collects capabilities and exposes capability predicates', async () => {
    const toolchain = await locateFfmpeg({ runner: scriptedRunner() });

    assert.equal(toolchain.ffmpeg.version.major, 6);
    assert.ok(toolchain.capabilities.encoders.includes('libx264'));
    assert.ok(toolchain.capabilities.filters.includes('scale'));
    assert.ok(toolchain.capabilities.filters.includes('transpose'));
    assert.ok(!toolchain.capabilities.filters.includes('='), 'legend rows must not become filters');
    assert.ok(toolchain.capabilities.muxers.includes('matroska'));
    assert.ok(toolchain.capabilities.muxers.includes('mp4'));
    assert.ok(!toolchain.capabilities.muxers.includes('aac'), 'demux-only formats are not muxers');
    assert.ok(toolchain.capabilities.demuxers.includes('rtsp'));
    assert.ok(toolchain.capabilities.demuxers.includes('flv'));
    assert.ok(!toolchain.capabilities.demuxers.includes('webm'), 'mux-only formats are not demuxers');
    assert.equal(toolchain.hasDemuxer('rtsp'), true);
    assert.equal(toolchain.hasDemuxer('hevc'), false);
    assert.deepEqual(toolchain.capabilities.protocols, ['file', 'http', 'rtmp', 'rtsp']);
    assert.ok(toolchain.capabilities.hwaccels.includes('vaapi'));

    assert.equal(toolchain.hasEncoder('libx264'), true);
    assert.equal(toolchain.hasEncoder('libx265'), false);
    assert.equal(toolchain.hasFilter('transpose'), true);
    assert.equal(toolchain.hasProtocol('rtsp'), true);
    assert.deepEqual(toolchain.warnings, []);
  });

  test('a missing binary produces an installable-action error', async () => {
    await assert.rejects(
      () => locateFfmpeg({ runner: scriptedRunner({ missing: true }) }),
      (error: unknown) =>
        error instanceof MediaError &&
        error.code === 'toolchain-missing' &&
        /apt install ffmpeg/.test(error.detail ?? ''),
    );
  });

  test('an old FFmpeg is rejected with the detected version', async () => {
    await assert.rejects(
      () => locateFfmpeg({ runner: scriptedRunner({ ffmpegVersion: 'ffmpeg version 4.4.2 Copyright' }) }),
      (error: unknown) =>
        error instanceof MediaError &&
        error.code === 'toolchain-unsupported' &&
        /4\.4\.2/.test(error.message),
    );
  });

  test('mismatched ffmpeg/ffprobe majors are warned about, not fatal', async () => {
    const toolchain = await locateFfmpeg({
      runner: scriptedRunner({ ffprobeVersion: 'ffprobe version 5.1.2 Copyright' }),
    });
    assert.match(toolchain.warnings.join('\n'), /ffprobe 5\.1\.2/);
  });

  test('capability discovery failure disables the checks instead of blocking boot', async () => {
    const toolchain = await locateFfmpeg({ runner: scriptedRunner({ encoders: '' }) });
    assert.match(toolchain.warnings.join('\n'), /Could not enumerate FFmpeg encoders/);
    // Fail open: with no capability data a configured encoder is assumed usable.
    assert.equal(toolchain.hasEncoder('anything'), true);
  });

  test('skipCapabilities avoids the extra probes', async () => {
    const calls: string[] = [];
    const runner = scriptedRunner();
    const toolchain = await locateFfmpeg({
      skipCapabilities: true,
      runner: async (bin, args, timeout) => {
        calls.push(args.join(' '));
        return runner(bin, args, timeout);
      },
    });
    assert.deepEqual(calls, ['-hide_banner -version', '-hide_banner -version']);
    assert.deepEqual(toolchain.capabilities.encoders, []);
  });
});

describe('describeToolchain', () => {
  test('summarises versions and the encoders that matter', async () => {
    const toolchain = await locateFfmpeg({ runner: scriptedRunner() });
    const lines = describeToolchain(toolchain).join('\n');
    assert.match(lines, /ffmpeg {3}6\.1\.1/);
    assert.match(lines, /libx264/);
    assert.match(lines, /vaapi/);
  });
});
