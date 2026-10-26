# @icamify/core — configuration engine

The contract every other module builds on: typed config, defaults, environment
resolution, JSON Schema validation and referential integrity checks.

## Load pipeline

```
icamify.json (JSONC)
   │  parseJsonc: comments + trailing commas, precise line/column errors
   ▼
interpolateEnv: ${VAR} / ${VAR:-fallback} on every string
   ▼
deepMerge(DEFAULT_CONFIG, document)
   ▼
ICAMIFY_* environment overrides  →  programmatic overrides
   ▼
JSON Schema (config/icamify.schema.json, Ajv 2020-12)
   ▼
integrity checks (profiles, volumes, schedules, channels, zones, layouts...)
   ▼
ResolvedIcamifyConfig + structured warnings
```

Errors are `ConfigError` with `kind` (`missing-file`, `parse`, `env`, `schema`,
`semantics`, `version`) and a list of `{ severity, path, message, code }` issues.
Warnings never block startup; errors always do.

## CLI

```bash
node apps/server/src/cli.ts config validate --config config/icamify.example.json
node apps/server/src/cli.ts config validate --json
node apps/server/src/cli.ts config print       # secrets redacted
node apps/server/src/cli.ts config schema -o config/icamify.schema.json
```

## Modules

| File | Responsibility |
| ---- | -------------- |
| `config/types.ts` | TypeScript mirror of the schema |
| `config/defaults.ts` | Built-in profiles, defaults, `ICAMIFY_*` overrides |
| `config/jsonc.ts` | Comment/trailing-comma parser with offset-preserving errors |
| `config/env.ts` | `${VAR}` interpolation, missing-variable detection |
| `config/merge.ts` | Deep merge (objects merge, arrays replace), path helpers |
| `config/validate.ts` | Ajv compile, human-readable error paths, integrity checks |
| `config/mask.ts` | Zone grid codec: `1010/0101` ⇄ boolean matrix |
| `config/redact.ts` | Secret masking for logs, `config print` and API responses |
| `config/load.ts` | Orchestration, defaults isolation, error taxonomy |

## Notes

- Config is plain JSON on disk so it can be edited by hand, diffed in git and
  validated by the editor through `$schema`.
- The schema is the normative contract; tests assert the shipped example is valid
  and that broken documents fail with actionable paths.
- `structuredClone` isolates each load from the shared defaults object, so a
  reload cannot leak mutations into the next one.
