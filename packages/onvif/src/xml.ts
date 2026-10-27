/**
 * A very small, namespace-insensitive XML reader.
 *
 * ONVIF responses are deeply namespaced (`SOAP-ENV:Envelope`, `tt:Profiles`,
 * `ptz:Presets`, with prefixes that differ per vendor). A real DOM is unnecessary
 * for reading a handful of elements and would add a dependency to an NVR that is
 * meant to ship as one process; matching on local names is exactly the tolerance a
 * multi-vendor camera fleet needs.
 *
 * It is a reader, not a validator: malformed input yields whatever could be
 * parsed, and callers check for the elements they require.
 */

export interface XmlNode {
  /** Tag as written, including its prefix. */
  name: string;
  /** Tag without the prefix, which is what all lookups use. */
  local: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text directly inside this element. */
  text: string;
}

const DOCUMENT: XmlNode = { name: '#document', local: '#document', attributes: {}, children: [], text: '' };

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { ...DOCUMENT, children: [], attributes: {} };
  const stack: XmlNode[] = [root];
  let index = 0;

  const top = (): XmlNode => stack[stack.length - 1] ?? root;

  while (index < input.length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      top().text += decodeXmlEntities(input.slice(index));
      break;
    }
    if (lt > index) top().text += decodeXmlEntities(input.slice(index, lt));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt);
      top().text += end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt);
      index = end === -1 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      // Doctype; skip to the matching '>'.
      const end = input.indexOf('>', lt);
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    const gt = findTagEnd(input, lt);
    if (gt === -1) break;
    const raw = input.slice(lt + 1, gt).trim();
    index = gt + 1;

    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const split = body.search(/\s/);
    const name = (split === -1 ? body : body.slice(0, split)).trim();
    if (name.length === 0) continue;
    const node: XmlNode = {
      name,
      local: localName(name),
      attributes: parseAttributes(split === -1 ? '' : body.slice(split)),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** Index of the `>` that closes the tag that starts at `lt`, or -1. */
function findTagEnd(input: string, lt: number): number {
  let quote: string | undefined;
  for (let index = lt + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(input);
  while (match !== null) {
    const value = match[3] ?? match[4] ?? '';
    attributes[match[1] as string] = decodeXmlEntities(value);
    match = pattern.exec(input);
  }
  return attributes;
}

/** `SOAP-ENV:Envelope` → `Envelope`. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function findAll(node: XmlNode, local: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.local === local) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

export function findFirst(node: XmlNode, local: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.local === local) return child;
    const nested = findFirst(child, local);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Trimmed text of the first descendant with that local name. */
export function textOf(node: XmlNode | undefined, local: string): string | undefined {
  if (node === undefined) return undefined;
  const child = findFirst(node, local);
  if (child === undefined) return undefined;
  return collapse(child.text);
}

export function text(node: XmlNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  return collapse(node.text);
}

export function attribute(node: XmlNode | undefined, name: string): string | undefined {
  if (node === undefined) return undefined;
  const direct = node.attributes[name];
  if (direct !== undefined) return direct;
  // Vendors sometimes qualify attributes (`tt:token`); match the local part.
  for (const [key, value] of Object.entries(node.attributes)) {
    if (localName(key) === localName(name)) return value;
  }
  return undefined;
}

/** All descendants with a local name, each mapped through `read`. */
export function mapAll<T>(node: XmlNode, local: string, read: (child: XmlNode) => T | undefined): T[] {
  const values: T[] = [];
  for (const child of findAll(node, local)) {
    const value = read(child);
    if (value !== undefined) values.push(value);
  }
  return values;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function collapse(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed;
}
