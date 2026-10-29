import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ResolvedIcamifyConfig } from '@icamify/core';
import { LayoutError, LayoutService } from '../src/layouts/service.ts';
import { CAMERA, testConfig } from './helpers.ts';

/**
 * The layout store is the only place the console writes presentation state to disk.
 * These tests pin the contract the UI depends on: ids come from the URL, the grid
 * cannot contain overlapping or out-of-bounds tiles, exactly one layout is default,
 * and edits survive a restart.
 */

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function config(): ResolvedIcamifyConfig {
  const value = testConfig({ cameras: [CAMERA, { ...CAMERA, id: 'yard', name: 'Yard' }] });
  value.layouts = [
    {
      id: 'wall',
      name: 'Video wall',
      columns: 2,
      rows: 2,
      isDefault: true,
      tiles: [{ cameraId: 'front-door', x: 0, y: 0 }],
    },
  ];
  return value;
}

function service(settings?: { config?: ResolvedIcamifyConfig; root?: string }): { service: LayoutService; root: string } {
  const root = settings?.root ?? mkdtempSync(join(tmpdir(), 'icamify-layouts-'));
  if (settings?.root === undefined) roots.push(root);
  return { service: new LayoutService({ config: settings?.config ?? config(), stateDir: root }), root };
}

async function expectLayoutError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LayoutError, `expected LayoutError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

describe('LayoutService', () => {
  it('serves the configured layouts until something is saved', async () => {
    const { service: layouts } = service();
    const listed = await layouts.list();

    assert.equal(listed.stored, false);
    assert.equal(listed.layouts.length, 1);
    assert.equal(listed.defaultLayoutId, 'wall');
    assert.deepEqual(listed.layouts[0]?.tiles, [{ cameraId: 'front-door', x: 0, y: 0 }]);
  });

  it('creates a layout, defaults it and persists it', async () => {
    const { service: layouts, root } = service();

    const saved = await layouts.save({
      name: 'Ops wall',
      columns: 3,
      rows: 2,
      tiles: [
        { cameraId: 'front-door', x: 0, y: 0, width: 2, height: 2 },
        { cameraId: 'yard', x: 2, y: 0 },
      ],
    });

    assert.equal(saved.id, 'ops-wall');
    assert.notEqual(saved.isDefault, true, 'an existing default keeps its flag');
    assert.equal((await layouts.list()).defaultLayoutId, 'wall');

    const stored = JSON.parse(readFileSync(join(root, 'layouts.json'), 'utf8')) as { layouts: Array<{ id: string }> };
    assert.deepEqual(
      stored.layouts.map((layout) => layout.id),
      ['wall', 'ops-wall'],
    );

    // A new process sees the edit: the file, not the config, is the source of truth.
    const reopened = new LayoutService({ config: config(), stateDir: root });
    const listed = await reopened.list();
    assert.equal(listed.stored, true);
    assert.equal(listed.layouts.length, 2);
    assert.equal(listed.layouts[1]?.columns, 3);
  });

  it('makes the first saved layout the default when none exists', async () => {
    const value = config();
    value.layouts = [];
    const { service: layouts } = service({ config: value });

    const saved = await layouts.save({ name: 'Only', columns: 2, rows: 2, tiles: [] });

    assert.equal(saved.isDefault, true);
    assert.equal((await layouts.list()).defaultLayoutId, 'only');
  });

  it('rejects overlapping tiles', async () => {
    const { service: layouts } = service();
    await expectLayoutError(
      layouts.save({
        name: 'Overlap',
        columns: 3,
        rows: 2,
        tiles: [
          { cameraId: 'front-door', x: 0, y: 0, width: 2, height: 2 },
          { cameraId: 'yard', x: 1, y: 1, width: 2, height: 1 },
        ],
      }),
      'tiles-overlap',
    );
  });

  it('rejects tiles outside the grid and unknown cameras', async () => {
    const { service: layouts } = service();
    await expectLayoutError(
      layouts.save({ name: 'Too wide', columns: 2, rows: 2, tiles: [{ cameraId: 'front-door', x: 1, y: 0, width: 2 }] }),
      'tile-out-of-bounds',
    );
    await expectLayoutError(
      layouts.save({ name: 'Ghost', columns: 2, rows: 2, tiles: [{ cameraId: 'attic', x: 0, y: 0 }] }),
      'unknown-camera',
    );
    await expectLayoutError(
      layouts.save({ name: 'Twice', columns: 2, rows: 2, tiles: [{ cameraId: 'yard', x: 0, y: 0 }, { cameraId: 'yard', x: 1, y: 1 }] }),
      'duplicate-camera',
    );
  });

  it('rejects an invalid grid size', async () => {
    const { service: layouts } = service();
    await expectLayoutError(layouts.save({ name: 'Huge', columns: 12, rows: 2 }), 'out-of-range');
    await expectLayoutError(layouts.save({ name: 'Zero', columns: 0, rows: 2 }), 'out-of-range');
  });

  it('takes the id from the URL, not the body', async () => {
    const { service: layouts } = service();

    const saved = await layouts.save({ id: 'other', name: 'Ops wall', columns: 2, rows: 2 }, 'ops-wall');

    assert.equal(saved.id, 'ops-wall');
    assert.equal((await layouts.get('other')), undefined);
  });

  it('keeps exactly one default layout', async () => {
    const { service: layouts } = service();
    await layouts.save({ name: 'Ops wall', columns: 2, rows: 2 });

    const promoted = await layouts.setDefault('ops-wall');
    assert.equal(promoted.isDefault, true);
    const listed = await layouts.list();
    assert.equal(listed.layouts.filter((layout) => layout.isDefault).length, 1);
    assert.equal(listed.defaultLayoutId, 'ops-wall');

    // Deleting the default promotes the survivor rather than leaving none.
    assert.equal(await layouts.remove('ops-wall'), true);
    const after = await layouts.list();
    assert.equal(after.layouts.length, 1);
    assert.equal(after.defaultLayoutId, after.layouts[0]?.id);
  });

  it('drops tiles for cameras that no longer exist when loading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icamify-layouts-'));
    roots.push(root);
    writeFileSync(
      join(root, 'layouts.json'),
      JSON.stringify({
        version: 1,
        layouts: [
          {
            id: 'stale',
            name: 'Stale',
            columns: 2,
            rows: 2,
            tiles: [
              { cameraId: 'yard', x: 0, y: 0 },
              { cameraId: 'removed-camera', x: 1, y: 1 },
            ],
          },
        ],
      }),
    );

    const listed = await new LayoutService({ config: config(), stateDir: root }).list();

    assert.equal(listed.layouts.length, 1);
    assert.deepEqual(
      listed.layouts[0]?.tiles?.map((tile) => tile.cameraId),
      ['yard'],
    );
  });

  it('falls back to the configuration when the stored file is corrupt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'icamify-layouts-'));
    roots.push(root);
    writeFileSync(join(root, 'layouts.json'), '{ not json');

    const listed = await new LayoutService({ config: config(), stateDir: root }).list();

    assert.equal(listed.stored, false);
    assert.equal(listed.layouts[0]?.id, 'wall');
  });
});
