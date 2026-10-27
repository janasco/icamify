import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildS3Url,
  createArchiveTarget,
  LocalArchiveTarget,
  S3ArchiveTarget,
  sftpBatch,
  signAwsV4,
} from '../src/archive/index.ts';
import { StorageError } from '../src/errors.ts';
import { archiveObjectKey, keySegments } from '../src/archive/types.ts';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('archiveObjectKey', () => {
  it('uses camera and day, so a re-upload overwrites instead of duplicating', () => {
    const key = archiveObjectKey({
      cameraId: 'front door',
      startedAt: Date.parse('2026-03-05T22:15:00Z'),
      fileName: '221500-motion.mkv',
    });
    assert.equal(key, 'front_door/2026-03-05/221500-motion.mkv');
  });

  it('strips traversal attempts from every segment', () => {
    assert.deepEqual(keySegments('../../etc/passwd'), ['_', '_', 'etc', 'passwd']);
    assert.deepEqual(keySegments('/absolute/path'), ['absolute', 'path']);
    assert.deepEqual(keySegments(''), ['unnamed']);
  });
});

describe('LocalArchiveTarget', () => {
  it('copies into a nested root', async () => {
    const source = tmp('icamify-archive-src-');
    const target = tmp('icamify-archive-dst-');
    const file = join(source, 'clip.mkv');
    writeFileSync(file, Buffer.from('recording bytes'));

    const archive = new LocalArchiveTarget({ id: 'nas', type: 'local', path: join(target, 'cold') });
    await archive.upload(file, 'front-door/2026-03-05/clip.mkv');
    const copy = join(target, 'cold', 'front-door', '2026-03-05', 'clip.mkv');
    assert.equal(existsSync(copy), true);
    assert.equal(readFileSync(copy, 'utf8'), 'recording bytes');
    assert.equal(archive.label, join(target, 'cold'));
    await archive.close();
  });

  it('refuses an absolute key', async () => {
    const source = tmp('icamify-archive-src-');
    const file = join(source, 'clip.mkv');
    writeFileSync(file, Buffer.from('x'));
    const archive = new LocalArchiveTarget({ id: 'nas', type: 'local', path: tmp('icamify-archive-dst-') });
    await assert.rejects(() => archive.upload(file, '/etc/passwd'), StorageError);
  });

  it('fails loudly when the source is gone', async () => {
    const archive = new LocalArchiveTarget({ id: 'nas', type: 'local', path: tmp('icamify-archive-dst-') });
    await assert.rejects(() => archive.upload('/nonexistent/clip.mkv', 'a/b.mkv'));
  });
});

describe('sftpBatch', () => {
  it('creates the remote tree, then puts the file', () => {
    assert.deepEqual(sftpBatch('/mnt/archive', 'front-door/2026-03-05/clip.mkv', '/data/clip.mkv'), [
      '-mkdir /mnt/archive/front-door',
      '-mkdir /mnt/archive/front-door/2026-03-05',
      '-rm /mnt/archive/front-door/2026-03-05/clip.mkv',
      'put /data/clip.mkv /mnt/archive/front-door/2026-03-05/clip.mkv',
    ]);
  });

  it('keeps trailing-slash-free roots intact', () => {
    const lines = sftpBatch('/archive/', 'clip.mkv', '/data/clip.mkv');
    assert.deepEqual(lines, ['-rm /archive/clip.mkv', 'put /data/clip.mkv /archive/clip.mkv']);
  });
});

describe('S3 signing', () => {
  it('matches the AWS SigV4 documented example', () => {
    const result = signAwsV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(result.amzDate, '20130524T000000Z');
    assert.equal(result.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
    assert.equal(result.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.match(result.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
  });

  it('is deterministic and changes with the payload hash', () => {
    const base = {
      method: 'PUT',
      url: new URL('https://bucket.s3.eu-central-1.amazonaws.com/a/b.mkv'),
      region: 'eu-central-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      headers: { host: 'bucket.s3.eu-central-1.amazonaws.com' },
      now: new Date('2026-01-01T00:00:00Z'),
    };
    const first = signAwsV4({ ...base, payloadHash: 'UNSIGNED-PAYLOAD' });
    const again = signAwsV4({ ...base, payloadHash: 'UNSIGNED-PAYLOAD' });
    const other = signAwsV4({ ...base, payloadHash: 'a'.repeat(64) });
    assert.equal(first.signature, again.signature);
    assert.notEqual(first.signature, other.signature);
    assert.match(first.canonicalRequest, /^PUT\n\/a\/b\.mkv\n\nhost:bucket\.s3\.eu-central-1\.amazonaws\.com\n/);
  });
});

describe('buildS3Url', () => {
  it('uses virtual hosting on an AWS endpoint', () => {
    const url = buildS3Url({ region: 'eu-central-1', bucket: 'clips', prefix: '/nvr/' }, 'cam/2026-03-05/a.mkv');
    assert.equal(url.toString(), 'https://clips.s3.eu-central-1.amazonaws.com/nvr/cam/2026-03-05/a.mkv');
  });

  it('uses path style for a custom endpoint', () => {
    const url = buildS3Url({ endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'clips' }, 'cam/a.mkv');
    assert.equal(url.toString(), 'http://127.0.0.1:9000/clips/cam/a.mkv');
  });

  it('forces path style on request', () => {
    const url = buildS3Url({ region: 'us-east-1', bucket: 'clips', forcePathStyle: true }, 'a.mkv');
    assert.equal(url.toString(), 'https://s3.us-east-1.amazonaws.com/clips/a.mkv');
  });
});

describe('S3ArchiveTarget', () => {
  async function mockS3(status: number, body: string) {
    const seen: Array<{ method?: string; url?: string; headers: Record<string, string | string[] | undefined>; bytes: number }> = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, bytes });
        res.writeHead(status, { 'Content-Type': 'application/xml' });
        res.end(body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { seen, endpoint: `http://127.0.0.1:${port}` };
  }

  it('streams the file with a signed PUT', async () => {
    const { seen, endpoint } = await mockS3(200, '');
    const source = tmp('icamify-s3-');
    const file = join(source, 'clip.mkv');
    writeFileSync(file, Buffer.alloc(2048, 3));

    const target = new S3ArchiveTarget({
      id: 'cold',
      type: 's3',
      endpoint,
      region: 'us-east-1',
      bucket: 'clips',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      now: () => new Date('2026-03-05T10:00:00Z'),
    });
    await target.upload(file, 'front-door/2026-03-05/clip.mkv');

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, 'PUT');
    assert.equal(seen[0]?.url, '/clips/front-door/2026-03-05/clip.mkv');
    assert.equal(seen[0]?.bytes, 2048);
    assert.equal(seen[0]?.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    assert.equal(seen[0]?.headers['x-amz-date'], '20260305T100000Z');
    assert.match(String(seen[0]?.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIATEST\/20260305\/us-east-1\/s3\/aws4_request/);
    assert.equal(target.label, 's3://clips');
  });

  it('surfaces the S3 error message', async () => {
    const { endpoint } = await mockS3(
      403,
      '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
    );
    const source = tmp('icamify-s3-');
    const file = join(source, 'clip.mkv');
    writeFileSync(file, Buffer.from('x'));

    const target = new S3ArchiveTarget({
      id: 'cold',
      type: 's3',
      endpoint,
      region: 'us-east-1',
      bucket: 'clips',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
    });
    await assert.rejects(
      () => target.upload(file, 'clip.mkv'),
      (error: unknown) => {
        assert.equal(error instanceof StorageError, true);
        assert.match((error as Error).message, /\(403 AccessDenied\): Access Denied/);
        return true;
      },
    );
  });

  it('refuses to be built without credentials', () => {
    assert.throws(
      () => new S3ArchiveTarget({ id: 'cold', type: 's3', region: 'us-east-1', bucket: 'clips' }),
      StorageError,
    );
  });
});

describe('createArchiveTarget', () => {
  it('builds each configured type', () => {
    assert.equal(createArchiveTarget({ id: 'a', type: 'local', path: '/tmp/x' }).providerId, 'a');
    assert.equal(
      createArchiveTarget({
        id: 'b',
        type: 's3',
        region: 'us-east-1',
        bucket: 'clips',
        accessKeyId: 'k',
        secretAccessKey: 's',
      }).providerId,
      'b',
    );
  });

  it('rejects a disabled provider', () => {
    assert.throws(() => createArchiveTarget({ id: 'a', type: 'local', path: '/tmp/x', enabled: false }), StorageError);
  });

  it('rejects SFTP with a password but no key', () => {
    assert.throws(
      () => createArchiveTarget({ id: 'c', type: 'sftp', host: 'nas', remoteDir: '/archive', password: 'secret' }),
      (error: unknown) => {
        assert.match((error as Error).message, /key authentication/);
        return true;
      },
    );
  });
});
