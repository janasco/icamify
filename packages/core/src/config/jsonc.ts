/**
 * Minimal JSONC reader.
 *
 * Camera configs are edited by humans, so the loader accepts `//` comments,
 * block comments and trailing commas while keeping character offsets intact so
 * JSON.parse error positions still point at the offending line of the original
 * file.
 */

export class JsoncParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly offset: number;

  constructor(message: string, line: number, column: number, offset: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'JsoncParseError';
    this.line = line;
    this.column = column;
    this.offset = offset;
  }
}

/** Replace comments with spaces, preserving every newline and byte offset. */
function stripComments(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < input.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Drop commas that are followed only by whitespace and a closing bracket. */
function stripTrailingCommas(input: string): string {
  const chars = [...input];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j]!)) j += 1;
      if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
    }
  }

  return chars.join('');
}

export function positionOf(input: string, offset: number): { line: number; column: number } {
  const upto = input.slice(0, offset);
  const line = upto.split('\n').length;
  const column = offset - upto.lastIndexOf('\n');
  return { line, column };
}

export function parseJsonc(input: string, source = 'config'): unknown {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? ` ${input.slice(1)}` : input;
  const cleaned = stripTrailingCommas(stripComments(withoutBom));

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /position (\d+)/.exec(message);
    if (match) {
      const offset = Number(match[1]);
      const { line, column } = positionOf(cleaned, offset);
      throw new JsoncParseError(
        `${source}: invalid JSON (${message.replace(/ in JSON at position \d+/, '')})`,
        line,
        column,
        offset,
      );
    }
    throw new JsoncParseError(`${source}: ${message}`, 1, 1, 0);
  }
}
