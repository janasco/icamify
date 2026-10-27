import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ArchiveS3 } from '@icamify/core';
import { StorageError } from '../errors.ts';
import { describeArchiveProvider, keySegments, type ArchiveTarget } from './types.ts';

/**
 * S3-compatible archiver (AWS, MinIO, Backblaze, Wasabi, …).
 *
 * Written directly against SigV4 rather than pulling in the AWS SDK: the only
 * operation needed is `PutObject`, the SDK adds tens of megabytes to a NVR that
 * is meant to run on a small box, and the signing rules are stable.
 *
 * The payload is streamed with `UNSIGNED-PAYLOAD`, so a multi-gigabyte segment
 * is never read into memory or hashed twice. AWS requires HTTPS for that mode,
 * which is what a real endpoint uses; a plain-HTTP endpoint is accepted only for
 * local MinIO-style deployments.
 */

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface S3Location {
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

export interface SignRequestOptions {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  /** Already includes `host`; names are lowercased by the signer. */
  headers: Record<string, string>;
  now: Date;
}

export interface SignRequestResult {
  authorization: string;
  amzDate: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `AWS4<secret>` → date → region → service → `aws4_request`. */
export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service = 's3'): Buffer {
  const date = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const regional = hmacSha256(date, region);
  const scoped = hmacSha256(regional, service);
  return hmacSha256(scoped, 'aws4_request');
}

export function amzDateStamp(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const amzDate = iso.replace(/[-:]/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * SigV4 signature for one request.
 *
 * Header values are trimmed and internal runs of whitespace are collapsed, as the
 * specification requires; unsigned headers (content-length, content-type) are
 * sent separately by the caller and deliberately kept out of `SignedHeaders`.
 */
export function signAwsV4(options: SignRequestOptions): SignRequestResult {
  const { amzDate, dateStamp } = amzDateStamp(options.now);
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;

  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(options.headers)) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
  }
  headers.set('x-amz-date', amzDate);
  headers.set('x-amz-content-sha256', options.payloadHash);
  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name) ?? ''}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(options.url),
    canonicalQuery(options.url),
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(options.secretAccessKey, dateStamp, options.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    authorization: `${ALGORITHM} Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** Path with each segment RFC 3986 encoded (%2F is not a separator). */
export function canonicalUri(url: URL): string {
  const path = url.pathname.length === 0 ? '/' : url.pathname;
  return path
    .split('/')
    .map((segment) => encodeURIComponent(decodePercent(segment)))
    .join('/');
}

/** `decodeURIComponent` throws on stray `%`; a key is not worth crashing over. */
function decodePercent(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function canonicalQuery(url: URL): string {
  const entries = [...url.searchParams.entries()].map(([name, value]) => [
    encodeURIComponent(name),
    encodeURIComponent(value),
  ]);
  entries.sort((left, right) => (left[0]! === right[0]! ? left[1]!.localeCompare(right[1]!) : left[0]!.localeCompare(right[0]!)));
  return entries.map(([name, value]) => `${name}=${value}`).join('&');
}

/**
 * Object URL. A custom endpoint (MinIO, Ceph, a gateway) always uses path style,
 * because most of them do not provide the wildcard DNS that virtual hosting needs.
 */
export function buildS3Url(location: S3Location, key: string): URL {
  const base = new URL(location.endpoint ?? `https://s3.${location.region}.amazonaws.com`);
  const objectKey = keySegments(key).join('/');
  const prefix = (location.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const fullKey = prefix.length === 0 ? objectKey : `${prefix}/${objectKey}`;
  const basePath = base.pathname.replace(/\/+$/, '');
  const virtualHosted = location.forcePathStyle !== true && location.endpoint === undefined;

  if (virtualHosted) {
    base.hostname = `${location.bucket}.${base.hostname}`;
    base.pathname = `${basePath}/${fullKey}`;
  } else {
    base.pathname = `${basePath}/${location.bucket}/${fullKey}`;
  }
  base.search = '';
  base.hash = '';
  return base;
}

export interface S3ArchiveOptions extends ArchiveS3 {
  now?: () => Date;
  /** Test seam; production always uses the real transports. */
  transport?: typeof httpRequest;
}

export class S3ArchiveTarget implements ArchiveTarget {
  readonly providerId: string;
  readonly label: string;

  private readonly options: S3ArchiveOptions;
  private readonly location: S3Location;

  constructor(options: S3ArchiveOptions) {
    this.options = options;
    this.providerId = options.id;
    this.label = describeArchiveProvider(options);
    this.location = {
      region: options.region ?? 'us-east-1',
      bucket: options.bucket,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
    };
    if (options.accessKeyId === undefined || options.accessKeyId.length === 0) {
      throw new StorageError('archive-credentials', `Archive provider "${options.id}" has no accessKeyId.`, {
        providerId: options.id,
      });
    }
    if (options.secretAccessKey === undefined || options.secretAccessKey.length === 0) {
      throw new StorageError('archive-credentials', `Archive provider "${options.id}" has no secretAccessKey.`, {
        providerId: options.id,
      });
    }
  }

  async upload(path: string, key: string, signal?: AbortSignal): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) {
      throw new StorageError('archive-failed', `Cannot archive "${path}": the file disappeared.`, {
        providerId: this.providerId,
      });
    }
    const url = buildS3Url(this.location, key);
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': UNSIGNED_PAYLOAD,
    };
    if (this.options.storageClass !== undefined) headers['x-amz-storage-class'] = this.options.storageClass;

    const signed = signAwsV4({
      method: 'PUT',
      url,
      region: this.location.region,
      accessKeyId: this.options.accessKeyId ?? '',
      secretAccessKey: this.options.secretAccessKey ?? '',
      payloadHash: UNSIGNED_PAYLOAD,
      headers,
      now: (this.options.now ?? (() => new Date()))(),
    });

    await this.put(url, {
      ...headers,
      'x-amz-date': signed.amzDate,
      authorization: signed.authorization,
      'content-length': String(info.size),
      'content-type': 'application/octet-stream',
    }, path, signal);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  private put(url: URL, headers: Record<string, string>, path: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : this.options.transport ?? httpRequest;
      const request = transport(
        {
          method: 'PUT',
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port.length === 0 ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            if (chunks.length < 16) chunks.push(chunk);
          });
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve();
              return;
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? body.slice(0, 200).trim();
            const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
            reject(
              new StorageError(
                'archive-failed',
                `S3 PUT ${url.pathname} failed (${status}${code === undefined ? '' : ` ${code}`})${message.length === 0 ? '' : `: ${message}`}`,
                { providerId: this.providerId },
              ),
            );
          });
          response.on('error', (error) => reject(this.wrap(error)));
        },
      );

      const abort = (): void => {
        request.destroy(new StorageError('archive-failed', 'Archive upload cancelled.', { providerId: this.providerId }));
      };
      signal?.addEventListener('abort', abort, { once: true });

      request.on('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(error instanceof StorageError ? error : this.wrap(error));
      });

      const stream = createReadStream(path);
      stream.on('error', (error) => {
        request.destroy();
        reject(this.wrap(error));
      });
      stream.pipe(request);
    });
  }

  private wrap(error: unknown): StorageError {
    return new StorageError(
      'archive-failed',
      `S3 upload to ${this.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      { providerId: this.providerId, cause: error },
    );
  }
}
