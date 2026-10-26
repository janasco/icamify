import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'apps/server/src/cli.ts');
const EXAMPLE = 'config/icamify.example.json';
const tempDirs: string[] = [];

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function tempConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'icamify-cli-'));
  tempDirs.push(dir);
  const path = join(dir, 'icamify.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('prints version and schema location', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /icamify 0\.1\.0/);
  assert.match(result.stdout, /icamify\.schema\.json/);
});

test('validates the example config as JSON', () => {
  const result = run(['config', 'validate', '--config', EXAMPLE, '--json']);
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout) as {
    valid: boolean;
    summary: { cameras: number; profiles: number; volumes: number; rules: number; layouts: number };
    warnings: unknown[];
  };

  assert.equal(payload.valid, true);
  assert.equal(payload.summary.cameras, 6);
  assert.equal(payload.summary.profiles, 5);
  assert.equal(payload.summary.volumes, 2);
  assert.equal(payload.summary.rules, 4);
  assert.equal(payload.summary.layouts, 2);
  assert.ok(Array.isArray(payload.warnings));
});

test('exits 1 and lists issues for an invalid config', () => {
  const path = tempConfig({
    version: '1.0',
    cameras: [{ id: 'cam', name: 'Cam', streams: {} }],
  });

  const result = run(['config', 'validate', '--config', path, '--json']);
  assert.equal(result.status, 1);

  const payload = JSON.parse(result.stdout) as {
    valid: boolean;
    errors: Array<{ path: string; message: string; severity: string }>;
  };
  assert.equal(payload.valid, false);
  assert.ok(payload.errors.length > 0);
  assert.ok(payload.errors.every((issue) => issue.severity === 'error'));
  assert.ok(payload.errors.some((issue) => issue.path === 'cameras[0].streams.main'));
});

test('config print redacts secrets', () => {
  const result = run(['config', 'print', '--config', EXAMPLE]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('dev-only-session-secret-change-me-please-0123456789'));
  assert.match(result.stdout, /"\*\*\*"/);

  const printed = JSON.parse(result.stdout) as { auth: { session: { secret: string } } };
  assert.equal(printed.auth.session.secret, '***');
});

test('config schema emits a valid JSON Schema', () => {
  const result = run(['config', 'schema']);
  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout) as { $id: string; properties: Record<string, unknown> };
  assert.match(schema.$id, /icamify-config-1\.0/);
  assert.ok(schema.properties.cameras);
  assert.ok(schema.properties.storage);
});

test('reports an unknown subcommand with exit code 2', () => {
  const result = run(['config', 'frobnicate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown config command/);
});
