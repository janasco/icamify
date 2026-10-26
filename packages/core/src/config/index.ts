export * from './types.ts';
export {
  DEFAULT_CONFIG,
  DEFAULT_PROFILES,
  ENV_OVERRIDES,
} from './defaults.ts';
export {
  ConfigError,
  defaultConfigPath,
  loadConfig,
  parseConfigText,
  SUPPORTED_CONFIG_VERSION,
  type ConfigErrorKind,
  type LoadConfigOptions,
  type LoadedConfig,
} from './load.ts';
export {
  createConfigValidator,
  getConfigSchema,
  getConfigSchemaPath,
  validateSchema,
  checkSemantics,
  assertSchema,
  assertSemantics,
  toDottedPath,
} from './validate.ts';
export {
  activeCellCount,
  allActiveMask,
  decodeZoneMask,
  encodeZoneMask,
  toZoneGrid,
  zoneMaskIssues,
  type ZoneGrid,
  type ZoneMaskError,
  type ZoneMaskInput,
} from './mask.ts';
export { interpolateEnv, type EnvReference, type InterpolationResult } from './env.ts';
export { deepMerge, getPath, isPlainObject, setPath, type JsonValue } from './merge.ts';
export { isSecretKey, redactConfig, redactUrlSecrets, REDACTED } from './redact.ts';
export { resolveMotionThresholds, type EffectiveMotionThresholds } from './motion.ts';
export { parseJsonc, JsoncParseError, positionOf } from './jsonc.ts';
