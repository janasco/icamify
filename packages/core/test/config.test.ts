import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  ConfigError,
  DEFAULT_CONFIG,
  activeCellCount,
  createConfigValidator,
  decodeZoneMask,
  encodeZoneMask,
  loadConfig,
  redactConfig,
  resolveMotionThresholds,
  toZoneGrid,
  validateSchema,
  zoneMaskIssues,
} from '../src/index.ts';

const EXAMPLE = 'config/icamify.example.json';
const tempDirs: string[] = [];

function tempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'icamify-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'icamify.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return path;
}

function camera(id = 'cam', extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    streams: { main: { type: 'file', path: './data/sample.mp4' } },
    ...extra,
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0',
    auth: { mode: 'none' },
    storage: { volumes: [{ id: 'v1', path: 'recordings', maxSizeGb: 10 }] },
    cameras: [camera()],
    ...overrides,
  };
}

function expectConfigError(fn: () => unknown, kind: ConfigError['kind']): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    assert.equal(error.kind, kind, `expected kind ${kind}, got ${error.kind}: ${error.message}`);
    return error;
  }
  assert.fail('expected loadConfig to throw');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('configuration loading', () => {
  test('loads the shipped example configuration', () => {
    const loaded = loadConfig({ path: EXAMPLE, env: {} });

    assert.equal(loaded.config.version, '1.0');
    assert.equal(loaded.config.cameras.length, 6);
    assert.equal(loaded.config.cameras.filter((camera) => camera.enabled).length, 5);
    assert.equal(loaded.config.storage.defaultVolume, 'nvme');
    assert.deepEqual(loaded.config.streaming.fallbackChain, ['webrtc', 'mse', 'mjpeg']);
    assert.equal(loaded.config.layouts.find((layout) => layout.isDefault)?.id, 'overview');
    assert.equal(loaded.config.streaming.profiles?.['record-main']?.copy, true);
    assert.equal(loaded.config.streaming.profiles?.['record-main']?.video.codec, 'copy');
    assert.equal(loaded.config.cameras[0]?.id, 'front-door');
    assert.equal(loaded.config.cameras[0]?.streams.main.type, 'onvif');
    // Warnings are allowed but must be structured.
    for (const warning of loaded.warnings) {
      assert.equal(warning.severity, 'warning');
      assert.ok(warning.path.length > 0);
    }
    assert.deepEqual(loaded.envOverrides, []);
  });

  test('accepts comments and trailing commas', () => {
    const path = tempConfig(`{
      // camera matrix
      "version": "1.0",
      "auth": { "mode": "none" },
      /* storage */
      "cameras": [
        {
          "id": "cam",
          "name": "Camera",
          "streams": { "main": { "type": "file", "path": "./a.mp4" } },
          "recording": { "mode": "off" },
        },
      ],
    }`);

    const loaded = loadConfig({ path, env: {} });
    assert.equal(loaded.config.cameras.length, 1);
  });

  test('reports JSON syntax errors with a line number', () => {
    const path = tempConfig('{\n  "version": "1.0",\n  "cameras": [\n    { "id": "a" }\n    { "id": "b" }\n  ]\n}');
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'parse');
    assert.match(error.message, /line 5/);
  });

  test('missing file produces an actionable error', () => {
    const path = tempConfig({ version: '1.0' });
    rmSync(path);
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'missing-file');
    assert.match(error.message, /not found/);
  });

  test('rejects unknown top-level keys', () => {
    const path = tempConfig(baseConfig({ camras: [] }));
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'schema');
    assert.ok(
      error.issues.some((issue) => issue.code === 'additionalProperties' && issue.path === 'camras'),
      JSON.stringify(error.issues),
    );
  });

  test('rejects a camera without a main stream', () => {
    const path = tempConfig(
      baseConfig({
        cameras: [{ id: 'cam', name: 'Cam', streams: { sub: { type: 'file', path: './a.mp4' } } }],
      }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'schema');
    assert.ok(
      error.issues.some((issue) => issue.path === 'cameras[0].streams.main'),
      JSON.stringify(error.issues),
    );
  });

  test('rejects an unsupported config version', () => {
    const path = tempConfig(baseConfig({ version: '2.0' }));
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'version');
    assert.match(error.message, /unsupported config version/);
  });

  test('merges defaults but replaces arrays', () => {
    const path = tempConfig(
      baseConfig({
        motion: { sensitivity: 90 },
        groups: [{ id: 'only', name: 'Only group' }],
      }),
    );
    const loaded = loadConfig({ path, env: {} });

    assert.equal(loaded.config.motion.sensitivity, 90);
    assert.equal(loaded.config.motion.threshold, undefined);
    assert.equal(loaded.config.system.server?.port, 8060);
    assert.equal(loaded.config.storage.format, 'mkv');
    assert.equal(loaded.config.groups.length, 1);
    assert.deepEqual(loaded.config.motion.zones?.cols, 16);
    // Loaded configs must not alias the shared defaults object.
    loaded.config.motion.sensitivity = 99;
    assert.equal(DEFAULT_CONFIG.motion.sensitivity, 50);
  });

  test('applies ICAMIFY_* environment overrides', () => {
    const path = tempConfig(baseConfig());
    const loaded = loadConfig({ path, env: { ICAMIFY_PORT: '9100', ICAMIFY_LOG_LEVEL: 'debug' } });
    assert.equal(loaded.config.system.server?.port, 9100);
    assert.equal(loaded.config.system.logging?.level, 'debug');
    assert.deepEqual(loaded.envOverrides.sort(), ['ICAMIFY_LOG_LEVEL', 'ICAMIFY_PORT']);
  });

  test('rejects invalid environment overrides', () => {
    const path = tempConfig(baseConfig());
    expectConfigError(() => loadConfig({ path, env: { ICAMIFY_PORT: 'https' } }), 'env');
  });
});

describe('environment interpolation', () => {
  test('resolves references and fallbacks', () => {
    const path = tempConfig(
      baseConfig({
        system: {
          server: { publicUrl: '${PUBLIC_URL:-http://localhost:8060}' },
        },
        storage: {
          volumes: [{ id: 'v1', path: 'recordings', maxSizeGb: 10 }],
          rootDir: '${DATA_ROOT}',
        },
      }),
    );

    const loaded = loadConfig({ path, env: { DATA_ROOT: '/srv/icamify', PUBLIC_URL: 'https://nvr.example.com' } });
    assert.equal(loaded.config.system.server?.publicUrl, 'https://nvr.example.com');
    assert.equal(loaded.config.storage.rootDir, '/srv/icamify');
    assert.ok(loaded.envReferences.some((ref) => ref.name === 'DATA_ROOT'));
  });

  test('missing variables without fallback fail fast', () => {
    const path = tempConfig(
      baseConfig({
        system: { server: { publicUrl: '${NO_SUCH_VAR}' } },
      }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'env');
    assert.match(error.message, /NO_SUCH_VAR/);
    assert.ok(error.issues.some((issue) => issue.code === 'missing-env'));
  });
});

describe('referential integrity', () => {
  test('rejects an unknown stream profile', () => {
    const path = tempConfig(baseConfig({ cameras: [camera('cam', { profiles: { record: 'nope' } })] }));
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'unknown-profile' && issue.path === 'cameras[0].profiles.record'));
  });

  test('rejects duplicate camera ids', () => {
    const path = tempConfig(baseConfig({ cameras: [camera('cam'), camera('cam')] }));
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'duplicate-id'));
  });

  test('rejects a recording camera with no volume that accepts it', () => {
    const path = tempConfig(
      baseConfig({
        storage: { defaultVolume: 'v1', volumes: [{ id: 'v1', path: 'recordings', maxSizeGb: 10, cameraIds: ['other'] }] },
      }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'no-volume-for-camera'));
  });

  test('rejects scheduled recording without schedules', () => {
    const path = tempConfig(
      baseConfig({ cameras: [camera('cam', { recording: { mode: 'scheduled' } })] }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'scheduled-without-schedule'));
  });

  test('rejects unknown notification channels in rules', () => {
    const path = tempConfig(
      baseConfig({
        rules: [
          {
            id: 'r1',
            name: 'Rule',
            when: { events: ['motion'] },
            then: { notify: { channels: ['nope'] } },
          },
        ],
      }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'unknown-channel'));
  });

  test('rejects layout tiles outside the grid', () => {
    const path = tempConfig(
      baseConfig({
        layouts: [
          {
            id: 'l1',
            name: 'Layout',
            columns: 2,
            rows: 2,
            tiles: [{ cameraId: 'cam', x: 1, y: 1, width: 2, height: 1 }],
          },
        ],
      }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'tile-out-of-bounds'));
  });

  test('validates zone mask dimensions', () => {
    const path = tempConfig(
      baseConfig({ cameras: [camera('cam', { motion: { zones: { cols: 4, rows: 4, cells: '1111/1111' } } })] }),
    );
    const error = expectConfigError(() => loadConfig({ path, env: {} }), 'semantics');
    assert.ok(error.issues.some((issue) => issue.code === 'mask-rows'));
  });

  test('warns, but does not fail, on operational hazards', () => {
    const path = tempConfig(
      baseConfig({
        storage: { volumes: [{ id: 'v1', path: 'recordings' }] },
        layouts: [{ id: 'l1', name: 'Layout', columns: 1, rows: 1, tiles: [{ cameraId: 'cam', x: 0, y: 0 }] }],
      }),
    );
    const loaded = loadConfig({ path, env: {} });
    assert.ok(loaded.warnings.some((issue) => issue.code === 'unbounded-volume'));
    assert.ok(loaded.warnings.some((issue) => issue.code === 'no-default-layout'));
  });

  test('validates the bare schema object', () => {
    assert.deepEqual(validateSchema({ version: '1.0' }), []);
    const issues = validateSchema({ version: '1.0', cameras: [{ id: 'BAD ID', name: 'x', streams: {} }] });
    assert.ok(issues.length >= 2);
  });

  test('compiles the JSON Schema exactly once per path', () => {
    const validate = createConfigValidator();
    assert.equal(validate({ version: '1.0' }), true);
    assert.equal(createConfigValidator(), validate);
  });
});

describe('motion thresholds', () => {
  test('derives threshold and percent from sensitivity', () => {
    assert.deepEqual(resolveMotionThresholds(undefined), {
      sensitivity: 50,
      threshold: 34,
      percentThreshold: 2.62,
      derivedFromSensitivity: true,
    });
    assert.equal(resolveMotionThresholds({ sensitivity: 1 }).threshold, 60);
    assert.equal(resolveMotionThresholds({ sensitivity: 1 }).percentThreshold, 5);
    assert.equal(resolveMotionThresholds({ sensitivity: 100 }).threshold, 8);
    assert.equal(resolveMotionThresholds({ sensitivity: 100 }).percentThreshold, 0.2);
  });

  test('explicit thresholds always win', () => {
    const effective = resolveMotionThresholds({ sensitivity: 100, threshold: 40, percentThreshold: 3 });
    assert.equal(effective.threshold, 40);
    assert.equal(effective.percentThreshold, 3);
    assert.equal(effective.derivedFromSensitivity, false);
  });
});

describe('zone masks', () => {
  test('round-trips a painted grid', () => {
    const grid = [
      [true, false, true, false],
      [false, true, false, true],
    ];
    const encoded = encodeZoneMask(grid);
    assert.equal(encoded, '1010/0101');
    assert.deepEqual(decodeZoneMask(encoded, 4, 2), grid);
  });

  test('reports dimension and content problems', () => {
    assert.deepEqual(zoneMaskIssues({ cols: 4, rows: 2, cells: '1010/0101' }, 'm'), []);
    const issues = zoneMaskIssues({ cols: 4, rows: 2, cells: '101/0101/1111' }, 'm');
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ['mask-rows', 'mask-cols'],
    );
    assert.equal(zoneMaskIssues({ cols: 2, rows: 1, cells: '00' }, 'm')[0]?.code, 'mask-empty');
  });

  test('defaults to a fully active grid', () => {
    const zones = toZoneGrid(undefined);
    assert.equal(zones.cols, 16);
    assert.equal(activeCellCount(zones), 256);
  });
});

describe('redaction', () => {
  test('masks secret values but keeps structure', () => {
    const redacted = redactConfig({
      version: '1.0',
      auth: {
        session: { secret: 'super-secret-value' },
        users: [{ username: 'admin', passwordHash: '$argon2id$hash', role: 'admin' }],
      },
      cameras: [
        {
          id: 'cam',
          name: 'Camera',
          streams: {
            main: {
              type: 'rtsp',
              url: 'rtsp://admin:url-secret@10.0.0.5/live?channel=1&token=url-token',
              credentials: { password: 'p@ss' },
            },
          },
          ptz: { profileToken: 'profile_main' },
        },
      ],
      ai: { providers: [{ id: 'p', type: 'codeproject-ai', apiKey: 'key' }] },
      storage: { volumes: [{ id: 'v1', path: 'recordings' }] },
    });

    const json = JSON.stringify(redacted);
    assert.ok(!json.includes('super-secret-value'));
    assert.ok(!json.includes('$argon2id$hash'));
    assert.ok(!json.includes('p@ss'));
    assert.ok(!json.includes('"key"'));
    assert.ok(!json.includes('url-secret'));
    assert.ok(!json.includes('url-token'));
    const url = redacted.cameras?.[0]?.streams.main;
    assert.ok(url && url.type === 'rtsp' && url.url?.includes('channel=1'));
    assert.equal(redacted.cameras?.[0]?.ptz?.profileToken, 'profile_main');
    assert.equal(redacted.auth?.users?.[0]?.username, 'admin');
    assert.equal(redacted.auth?.users?.[0]?.passwordHash, '***');
    assert.equal(redacted.cameras?.[0]?.streams.main.type, 'rtsp');
    assert.equal(redacted.storage?.volumes?.[0]?.path, 'recordings');
  });
});
