/**
 * `${VAR}` and `${VAR:-fallback}` expansion for configuration documents.
 *
 * Secrets stay in the environment (or the service manager's secret store) and
 * never need to be written into icamify.json. A missing variable without a
 * fallback is a hard error rather than a silently empty credential.
 */

export interface EnvReference {
  /** Dotted path of the string that contained the reference. */
  path: string;
  name: string;
  hadFallback: boolean;
}

export interface InterpolationResult<T> {
  value: T;
  references: EnvReference[];
  missing: Array<{ name: string; path: string }>;
  malformed: Array<{ path: string; value: string }>;
}

const REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Env = Record<string, string | undefined>;

function resolveString(
  input: string,
  path: string,
  env: Env,
  acc: {
    references: EnvReference[];
    missing: Array<{ name: string; path: string }>;
    malformed: Array<{ path: string; value: string }>;
  },
): string {
  const replaced = input.replace(REF_PATTERN, (_all, name: string, fallback?: string) => {
    const hadFallback = fallback !== undefined;
    acc.references.push({ path, name, hadFallback });

    if (Object.prototype.hasOwnProperty.call(env, name)) {
      return env[name] ?? '';
    }
    if (hadFallback) return fallback;

    acc.missing.push({ name, path });
    return '';
  });

  // A leftover `${` means an unclosed or invalid reference; surface it instead of
  // starting the NVR with a literal "${..." credential.
  if (replaced.includes('${') && !input.includes('$$')) {
    acc.malformed.push({ path, value: input });
  }

  return replaced;
}

export function interpolateEnv<T>(input: T, env: Env = process.env): InterpolationResult<T> {
  const acc = {
    references: [] as EnvReference[],
    missing: [] as Array<{ name: string; path: string }>,
    malformed: [] as Array<{ path: string; value: string }>,
  };

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') return resolveString(node, path, env, acc);
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${path}[${index}]`));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value, path ? `${path}.${key}` : key);
      }
      return out;
    }
    return node;
  };

  return {
    value: walk(input, '') as T,
    references: acc.references,
    missing: acc.missing,
    malformed: acc.malformed,
  };
}
