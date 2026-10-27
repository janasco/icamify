import { spawn } from 'node:child_process';
import type { ArchiveSftp } from '@icamify/core';
import { StorageError } from '../errors.ts';
import { describeArchiveProvider, keySegments, type ArchiveTarget } from './types.ts';

/**
 * SFTP archiver built on the OpenSSH `sftp` client.
 *
 * There is no SFTP implementation in the Node standard library and no runtime
 * dependency is wanted, so this drives the client that every managed host already
 * has, in batch mode. The consequence is explicit: key-based authentication only.
 * A password cannot be fed to `sftp -b` without `sshpass`, and pretending
 * otherwise would leave the operator with an archive that silently never runs.
 * `sftpBatch` is exported and unit-tested; the transfer itself needs a real SSH
 * server, which is stated in the README instead of being faked in a test.
 */

export interface SftpArchiveOptions extends ArchiveSftp {
  /** Binary to run; overridable for hosts with a versioned OpenSSH. */
  sftpBinary?: string;
}

/** Batch commands that create the remote directory tree and upload the file. */
export function sftpBatch(remoteDir: string, key: string, localPath: string): string[] {
  const root = remoteDir.replace(/\/+$/, '');
  const segments = keySegments(key);
  const lines: string[] = [];
  let current = root.length === 0 ? '' : root;
  for (const segment of segments.slice(0, -1)) {
    current = current.length === 0 ? segment : `${current}/${segment}`;
    // `-` makes a failed mkdir (already exists) non-fatal.
    lines.push(`-mkdir ${current}`);
  }
  const target = current.length === 0 ? (segments.at(-1) ?? 'unnamed') : `${current}/${segments.at(-1) ?? 'unnamed'}`;
  lines.push(`-rm ${target}`);
  lines.push(`put ${localPath} ${target}`);
  return lines;
}

export class SftpArchiveTarget implements ArchiveTarget {
  readonly providerId: string;
  readonly label: string;
  private readonly options: SftpArchiveOptions;

  constructor(options: SftpArchiveOptions) {
    this.options = options;
    this.providerId = options.id;
    this.label = describeArchiveProvider(options);
    if (options.privateKeyPath === undefined && options.password !== undefined) {
      throw new StorageError(
        'archive-credentials',
        `Archive provider "${options.id}" uses a password, but SFTP archiving relies on the OpenSSH client and key authentication. Set privateKeyPath (or a key the ssh agent already knows).`,
        { providerId: options.id },
      );
    }
  }

  async upload(path: string, key: string, signal?: AbortSignal): Promise<void> {
    const remoteDir = this.options.remoteDir;
    const batch = sftpBatch(remoteDir, key, path).join('\n');
    const args = [
      '-b',
      '-',
      '-P',
      String(this.options.port ?? 22),
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ];
    if (this.options.privateKeyPath !== undefined) args.push('-i', this.options.privateKeyPath);
    const user = this.options.username;
    args.push(user === undefined ? this.options.host : `${user}@${this.options.host}`);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.sftpBinary ?? 'sftp', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8');
      });
      const abort = (): void => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (error) => {
        signal?.removeEventListener('abort', abort);
        reject(
          new StorageError(
            'archive-unavailable',
            `Could not run the sftp client: ${error.message}. Install OpenSSH or use a local/S3 archive target.`,
            { providerId: this.providerId, cause: error },
          ),
        );
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new StorageError(
            'archive-failed',
            `sftp exited with code ${String(code)}${stderr.trim().length === 0 ? '' : `: ${stderr.trim().split('\n').slice(-3).join(' ')}`}`,
            { providerId: this.providerId },
          ),
        );
      });
      child.stdin.end(`${batch}\n`);
    });
  }

  async close(): Promise<void> {
    // Each upload is its own client process.
  }
}
