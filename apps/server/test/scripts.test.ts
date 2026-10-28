import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ScriptError, ScriptRunner, type ScriptContext } from '../src/automation/script-runner.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'icamify-scripts-'));
  roots.push(dir);
  return dir;
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const CONTEXT: ScriptContext = {
  ruleId: 'person-alert',
  ruleName: 'Person at the door',
  cameraId: 'front-door',
  cameraName: 'Front door',
  kind: 'ai.object',
  label: 'person',
  confidence: 0.93,
  at: Date.UTC(2026, 0, 1, 12, 0, 0),
  severity: 'warning',
  title: 'Person detected',
  message: 'person detected on Front door',
  snapshot: 'front/snap.jpg',
  eventId: 'evt-1',
};

const ENV_SCRIPT = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  camera: process.env.ICAMIFY_CAMERA_ID,
  cameraName: process.env.ICAMIFY_CAMERA_NAME,
  label: process.env.ICAMIFY_LABEL,
  rule: process.env.ICAMIFY_RULE_ID,
  kind: process.env.ICAMIFY_EVENT_KIND,
  snapshot: process.env.ICAMIFY_SNAPSHOT,
  event: process.env.ICAMIFY_EVENT_ID,
  extra: process.env.EXTRA_FLAG,
}));
`;

describe('ScriptRunner', () => {
  test('runs a script with interpolated args and the ICAMIFY_* environment', async () => {
    const dir = temporaryDir();
    writeScript(dir, 'env.mjs', ENV_SCRIPT);
    const runner = new ScriptRunner({ enabled: true, directories: [dir], environment: { EXTRA_FLAG: 'on' } });

    const result = await runner.run(
      { path: 'env.mjs', args: ['--camera', '{cameraName}', '--label', '{label}', '--at', '{time}'] },
      CONTEXT,
    );

    assert.equal(result.ok, true, result.detail);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, string | string[]>;
    assert.deepEqual(parsed.args, ['--camera', 'Front door', '--label', 'person', '--at', '2026-01-01T12:00:00.000Z']);
    assert.equal(parsed.camera, 'front-door');
    assert.equal(parsed.cameraName, 'Front door');
    assert.equal(parsed.label, 'person');
    assert.equal(parsed.rule, 'person-alert');
    assert.equal(parsed.kind, 'ai.object');
    assert.equal(parsed.snapshot, 'front/snap.jpg');
    assert.equal(parsed.event, 'evt-1');
    assert.equal(parsed.extra, 'on');
    assert.match(result.detail, /exited 0/);
  });

  test('reports a non-zero exit with the first stderr line', async () => {
    const dir = temporaryDir();
    writeScript(dir, 'fail.mjs', "#!/usr/bin/env node\nprocess.stderr.write('the plate log is read-only\\n');\nprocess.exit(3);\n");
    const runner = new ScriptRunner({ enabled: true, directories: [dir] });

    const result = await runner.run({ path: 'fail.mjs' }, CONTEXT);
    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
    assert.match(result.detail, /exited 3/);
    assert.match(result.detail, /read-only/);
  });

  test('kills a script that exceeds its timeout', async () => {
    const dir = temporaryDir();
    writeScript(dir, 'slow.mjs', '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n');
    const runner = new ScriptRunner({ enabled: true, directories: [dir] });

    const result = await runner.run({ path: 'slow.mjs', timeoutSeconds: 0.3 }, CONTEXT);
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.detail, /timed out/);
  });

  test('refuses a script outside the configured directories', async () => {
    const parent = temporaryDir();
    const allowed = join(parent, 'allowed');
    mkdirSync(allowed);
    const outside = writeScript(parent, 'escape.mjs', "#!/usr/bin/env node\nprocess.exit(0);\n");
    const runner = new ScriptRunner({ enabled: true, directories: [allowed] });

    await assert.rejects(
      runner.run({ path: outside }, CONTEXT),
      (error: unknown) => error instanceof ScriptError && error.stage === 'outside-directories',
    );
    // A relative traversal out of the allowed root is rejected the same way.
    await assert.rejects(
      runner.run({ path: '../escape.mjs' }, CONTEXT),
      (error: unknown) => error instanceof ScriptError && error.stage === 'outside-directories',
    );
  });

  test('refuses to run anything when scripts are disabled', async () => {
    const dir = temporaryDir();
    writeScript(dir, 'ok.mjs', '#!/usr/bin/env node\n');
    const runner = new ScriptRunner({ directories: [dir] });

    await assert.rejects(
      runner.run({ path: 'ok.mjs' }, CONTEXT),
      (error: unknown) => error instanceof ScriptError && error.stage === 'disabled',
    );
  });

  test('reports a missing script and enforces the concurrency cap', async () => {
    const dir = temporaryDir();
    writeScript(dir, 'slow.mjs', '#!/usr/bin/env node\nsetTimeout(() => {}, 400);\n');
    const runner = new ScriptRunner({ enabled: true, directories: [dir], maxConcurrent: 1 });

    await assert.rejects(
      runner.run({ path: 'missing.mjs' }, CONTEXT),
      (error: unknown) => error instanceof ScriptError && error.stage === 'not-found',
    );

    const first = runner.run({ path: 'slow.mjs' }, CONTEXT);
    await assert.rejects(
      runner.run({ path: 'slow.mjs' }, CONTEXT),
      (error: unknown) => error instanceof ScriptError && error.stage === 'busy',
    );
    assert.equal((await first).ok, true);
    assert.equal(runner.activeRuns, 0);
  });
});
