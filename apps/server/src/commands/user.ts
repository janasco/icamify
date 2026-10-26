import { hashPassword } from '../http/auth.ts';

/**
 * `icamify user hash` — prints an argon2id PHC string for auth.users[].passwordHash.
 *
 * The password is read from stdin, never from argv: command lines are visible in
 * `ps` and in shell history, which is exactly where a password must not be.
 */

export async function runUserHash(): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write('Reading the password from stdin (press Ctrl-D when done; input is echoed by the terminal).\n');
  }

  const password = await readStdin();
  if (password.length === 0) {
    process.stderr.write('icamify user hash: no password received on stdin.\n');
    process.stderr.write('Usage: read -rs PASSWORD && printf %s "$PASSWORD" | icamify user hash\n');
    return 2;
  }

  try {
    const hash = await hashPassword(password);
    process.stdout.write(`${hash}\n`);
    process.stderr.write('Put this in auth.users[].passwordHash (the $argon2id$ prefix identifies the format).\n');
    return 0;
  } catch (error) {
    process.stderr.write(`icamify user hash: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // A single trailing newline is an artefact of `echo`, not part of the password.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
