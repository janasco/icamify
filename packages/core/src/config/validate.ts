import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { zoneMaskIssues } from './mask.ts';
import type {
  CameraConfig,
  ConfigIssue,
  IcamifyConfig,
  ResolvedIcamifyConfig,
  StorageVolume,
} from './types.ts';

/** config/icamify.schema.json lives at the repository root, four levels up. */
export function getConfigSchemaPath(schemaPath?: string): string {
  return schemaPath ?? fileURLToPath(new URL('../../../../config/icamify.schema.json', import.meta.url));
}

type AjvConstructor = new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

/** Ajv ships CommonJS builds; load the 2020-12 build through require. */
const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020') as AjvConstructor;

let schemaCache: { path: string; schema: Record<string, unknown> } | undefined;

export function getConfigSchema(schemaPath?: string): Record<string, unknown> {
  const path = getConfigSchemaPath(schemaPath);
  if (schemaCache?.path === path) return schemaCache.schema;

  const raw = readFileSync(path, 'utf8');
  const schema = JSON.parse(raw) as Record<string, unknown>;
  schemaCache = { path, schema };
  return schema;
}

let validatorCache: { path: string; validate: ValidateFunction } | undefined;

export function createConfigValidator(schemaPath?: string): ValidateFunction {
  const path = getConfigSchemaPath(schemaPath);
  if (validatorCache?.path === path) return validatorCache.validate;

  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
    validateFormats: false,
    ownProperties: true,
  });
  const validate = ajv.compile(getConfigSchema(path));
  validatorCache = { path, validate };
  return validate;
}

export function toDottedPath(instancePath: string): string {
  return instancePath
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
    .join('')
    .replace(/^\./, '');
}

function describeAjvError(error: ErrorObject): string {
  switch (error.keyword) {
    case 'additionalProperties':
      return `unknown option "${String(error.params.additionalProperty)}"`;
    case 'required':
      return `missing required field "${String(error.params.missingProperty)}"`;
    case 'oneOf':
      return 'does not match any allowed shape (check the "type" discriminator and required fields)';
    case 'pattern':
      return `does not match the required pattern (${String(error.params.pattern)})`;
    case 'enum':
      return `must be one of: ${(error.params.allowedValues as unknown[]).join(', ')}`;
    default:
      return error.message ?? 'is invalid';
  }
}

function issuePathFor(error: ErrorObject): string {
  const base = toDottedPath(error.instancePath);
  if (error.keyword === 'required') {
    const missing = String(error.params.missingProperty);
    return base ? `${base}.${missing}` : missing;
  }
  if (error.keyword === 'additionalProperties') {
    const extra = String(error.params.additionalProperty);
    return base ? `${base}.${extra}` : extra;
  }
  return base || '(root)';
}

export class ConfigSchemaError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`configuration failed schema validation (${issues.length} error${issues.length === 1 ? '' : 's'})`);
    this.name = 'ConfigSchemaError';
    this.issues = issues;
  }
}

/** Schema-only validation. Does not mutate the document. */
export function validateSchema(config: unknown, schemaPath?: string): ConfigIssue[] {
  const validate = createConfigValidator(schemaPath);
  if (validate(config)) return [];

  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  for (const error of validate.errors ?? []) {
    const path = issuePathFor(error);
    const message = describeAjvError(error);
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ severity: 'error', path, message, code: error.keyword });
  }
  return issues;
}

export function assertSchema(config: unknown, schemaPath?: string): void {
  const issues = validateSchema(config, schemaPath);
  if (issues.length > 0) throw new ConfigSchemaError(issues);
}

/**
 * Referential integrity and operational sanity.
 *
 * JSON Schema cannot express "this profile name must exist" or "this camera
 * needs a volume with room for it". These checks catch the mistakes that would
 * otherwise fail at 3am when the first motion event fires.
 */
export function checkSemantics(config: ResolvedIcamifyConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (path: string, code: string, message: string) =>
    issues.push({ severity: 'error', path, code, message });
  const warn = (path: string, code: string, message: string) =>
    issues.push({ severity: 'warning', path, code, message });

  const cameras = config.cameras ?? [];
  const cameraById = new Map<string, CameraConfig>();
  const profiles = config.streaming.profiles ?? {};
  const profileNames = new Set(Object.keys(profiles));
  const schedules = config.schedules ?? [];
  const scheduleIds = new Set(schedules.map((s) => s.id));
  const channels = config.notifications.channels ?? [];
  const channelIds = new Set(channels.map((c) => c.id));
  const providers = config.ai.providers ?? [];
  const providerIds = new Set(providers.map((p) => p.id));
  const volumes = config.storage.volumes ?? [];
  const volumeIds = new Set(volumes.map((v) => v.id));
  const archiveIds = new Set((config.storage.archiveProviders ?? []).map((a) => a.id));
  const groupIds = new Set((config.groups ?? []).map((g) => g.id));

  const uniqueIds = (items: Array<{ id?: string }>, path: string, label: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (!item.id) return;
      if (seen.has(item.id)) {
        error(`${path}[${index}].id`, 'duplicate-id', `duplicate ${label} id "${item.id}"`);
      }
      seen.add(item.id);
    });
  };

  uniqueIds(cameras, 'cameras', 'camera');
  uniqueIds(config.groups ?? [], 'groups', 'group');
  uniqueIds(config.layouts ?? [], 'layouts', 'layout');
  uniqueIds(schedules, 'schedules', 'schedule');
  uniqueIds(config.rules ?? [], 'rules', 'rule');
  uniqueIds(channels, 'notifications.channels', 'notification channel');
  uniqueIds(providers, 'ai.providers', 'AI provider');
  uniqueIds(volumes, 'storage.volumes', 'storage volume');
  uniqueIds(config.storage.archiveProviders ?? [], 'storage.archiveProviders', 'archive provider');
  uniqueIds(config.auth.users ?? [], 'auth.users', 'user');

  for (const camera of cameras) {
    if (cameraById.has(camera.id)) continue;
    cameraById.set(camera.id, camera);
  }

  // ---- streaming profiles -------------------------------------------------
  if (profileNames.size === 0) {
    error('streaming.profiles', 'no-profiles', 'at least one stream profile is required');
  }
  const checkProfileRef = (name: string | undefined, path: string) => {
    if (name === undefined) return;
    if (!profileNames.has(name)) {
      error(path, 'unknown-profile', `stream profile "${name}" is not defined in streaming.profiles`);
    }
  };

  checkProfileRef(config.streaming.defaults?.record, 'streaming.defaults.record');
  checkProfileRef(config.streaming.defaults?.live, 'streaming.defaults.live');
  checkProfileRef(config.streaming.defaults?.detect, 'streaming.defaults.detect');

  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile?.video) continue;
    if (profile.copy && profile.video.codec !== 'copy') {
      error(`streaming.profiles.${name}.copy`, 'copy-codec', 'copy=true requires video.codec="copy"');
    }
    if (profile.latency === 'low' && (profile.video.bframes ?? 0) > 0) {
      warn(
        `streaming.profiles.${name}.video.bframes`,
        'latency-bframes',
        'B-frames add latency; latency="low" profiles should keep bframes at 0',
      );
    }
    if (profile.video.codec === 'copy' && (profile.video.width || profile.video.height || profile.video.fps)) {
      warn(
        `streaming.profiles.${name}.video`,
        'copy-ignores-scaling',
        'scaling/fps settings are ignored when video.codec="copy"',
      );
    }
  }

  const chain = config.streaming.fallbackChain ?? [];
  if (new Set(chain).size !== chain.length) {
    error('streaming.fallbackChain', 'duplicate-transport', 'fallbackChain contains duplicate transports');
  }
  if (!config.streaming.webrtc?.enabled && chain.includes('webrtc')) {
    warn('streaming.fallbackChain', 'webrtc-disabled', 'WebRTC is disabled but still present in fallbackChain');
  }
  if (!config.streaming.mse?.enabled && chain.includes('mse')) {
    warn('streaming.fallbackChain', 'mse-disabled', 'MSE is disabled but still present in fallbackChain');
  }
  if (!config.streaming.mjpeg?.enabled && chain.includes('mjpeg')) {
    warn('streaming.fallbackChain', 'mjpeg-disabled', 'MJPEG is disabled but still present in fallbackChain');
  }
  const portRange = config.streaming.webrtc?.portRange;
  if (portRange?.min !== undefined && portRange?.max !== undefined && portRange.min > portRange.max) {
    error('streaming.webrtc.portRange', 'bad-port-range', 'portRange.min must be <= portRange.max');
  }

  // ---- system -------------------------------------------------------------
  const tls = config.system.tls;
  if (tls?.enabled) {
    if (!tls.certFile || !tls.keyFile) {
      error('system.tls', 'tls-incomplete', 'TLS is enabled but certFile/keyFile are not both set');
    }
  }
  if ((config.system.api?.corsOrigins ?? []).includes('*')) {
    error('system.api.corsOrigins', 'cors-wildcard', 'wildcard CORS origins are rejected; list explicit origins');
  }

  // ---- auth ---------------------------------------------------------------
  const users = config.auth.users ?? [];
  if (config.auth.mode === 'local') {
    if (users.length === 0) {
      warn(
        'auth.users',
        'no-users',
        'auth.mode is "local" but no users exist; the UI cannot be used until an admin is created',
      );
    } else if (!users.some((u) => u.role === 'admin' && u.enabled !== false)) {
      warn('auth.users', 'no-admin', 'no enabled admin user exists');
    }
    const secret = config.auth.session?.secret;
    if (!secret) {
      warn(
        'auth.session.secret',
        'no-session-secret',
        'auth.session.secret is not set; sessions fall back to a generated process-local key',
      );
    } else if (secret.length < 32) {
      warn('auth.session.secret', 'weak-session-secret', 'session secret should be at least 32 characters');
    }
  }
  const usernames = new Set<string>();
  for (const [index, user] of users.entries()) {
    if (usernames.has(user.username)) {
      error(`auth.users[${index}].username`, 'duplicate-username', `duplicate username "${user.username}"`);
    }
    usernames.add(user.username);
    if (/replace/i.test(user.passwordHash)) {
      warn(
        `auth.users[${index}].passwordHash`,
        'placeholder-password',
        `password hash for "${user.username}" is a placeholder; replace it with a real argon2id hash before enabling auth`,
      );
    }
  }

  // ---- storage ------------------------------------------------------------
  if (volumes.length > 0) {
    if (!config.storage.defaultVolume) {
      warn(
        'storage.defaultVolume',
        'no-default-volume',
        'no default volume set; cameras without a matching volume will not record',
      );
    } else if (!volumeIds.has(config.storage.defaultVolume)) {
      error(
        'storage.defaultVolume',
        'unknown-volume',
        `default volume "${config.storage.defaultVolume}" is not defined`,
      );
    }
  }
  const volumePaths = new Set<string>();
  volumes.forEach((volume: StorageVolume, index) => {
    if (volumePaths.has(volume.path)) {
      warn(`storage.volumes[${index}].path`, 'duplicate-volume-path', `volume path "${volume.path}" is used twice`);
    }
    volumePaths.add(volume.path);
    if (volume.maxSizeGb === undefined && volume.maxAgeHours === undefined) {
      warn(
        `storage.volumes[${index}]`,
        'unbounded-volume',
        `volume "${volume.id}" has neither maxSizeGb nor maxAgeHours; it will grow until the disk is full`,
      );
    }
    for (const cameraId of volume.cameraIds ?? []) {
      if (!cameraById.has(cameraId)) {
        error(
          `storage.volumes[${index}].cameraIds`,
          'unknown-camera',
          `volume "${volume.id}" references unknown camera "${cameraId}"`,
        );
      }
    }
    if (volume.archive?.enabled) {
      if (!volume.archive.providerId || !archiveIds.has(volume.archive.providerId)) {
        error(
          `storage.volumes[${index}].archive.providerId`,
          'unknown-archive-provider',
          'archive is enabled but providerId does not reference a configured archiveProviders entry',
        );
      } else if (config.storage.archiveProviders?.find((p) => p.id === volume.archive?.providerId)?.enabled === false) {
        warn(
          `storage.volumes[${index}].archive`,
          'archive-disabled',
          'archiving is enabled on the volume but its provider is disabled',
        );
      }
    }
  });
  if (!/\{ext\}/.test(config.storage.filenameTemplate ?? '')) {
    warn(
      'storage.filenameTemplate',
      'template-no-ext',
      'filenameTemplate should contain "{ext}" so recordings get a file extension',
    );
  }

  const volumeAccepts = (volume: StorageVolume, cameraId: string): boolean =>
    !volume.cameraIds || volume.cameraIds.length === 0 || volume.cameraIds.includes(cameraId);

  // ---- schedules ----------------------------------------------------------
  for (const [index, schedule] of schedules.entries()) {
    for (const [windowIndex, window] of schedule.windows.entries()) {
      if (window.start === window.end) {
        error(
          `schedules[${index}].windows[${windowIndex}]`,
          'empty-window',
          `schedule "${schedule.id}" has a zero-length window (${window.start}-${window.end})`,
        );
      }
    }
  }
  const checkScheduleRefs = (ids: string[] | undefined, path: string) => {
    for (const id of ids ?? []) {
      if (!scheduleIds.has(id)) {
        error(path, 'unknown-schedule', `unknown schedule "${id}"`);
      }
    }
  };

  // ---- cameras ------------------------------------------------------------
  for (const [index, camera] of cameras.entries()) {
    const path = `cameras[${index}]`;
    checkProfileRef(camera.profiles?.record, `${path}.profiles.record`);
    checkProfileRef(camera.profiles?.live, `${path}.profiles.live`);
    checkProfileRef(camera.profiles?.detect, `${path}.profiles.detect`);
    checkProfileRef(camera.recording?.profile, `${path}.recording.profile`);

    for (const groupId of camera.groupIds ?? []) {
      if (!groupIds.has(groupId)) {
        error(`${path}.groupIds`, 'unknown-group', `unknown camera group "${groupId}"`);
      }
    }

    const recording = camera.recording;
    const records = recording?.enabled !== false && recording?.mode !== 'off';
    if (records) {
      checkScheduleRefs(recording?.scheduleIds, `${path}.recording.scheduleIds`);
      if (recording?.mode === 'scheduled' && (recording.scheduleIds ?? []).length === 0) {
        error(
          `${path}.recording.scheduleIds`,
          'scheduled-without-schedule',
          `camera "${camera.id}" records on a schedule but no scheduleIds are set`,
        );
      }
      if (recording?.mode === 'motion' && camera.motion?.enabled === false) {
        warn(
          `${path}.recording`,
          'motion-recording-disabled',
          `camera "${camera.id}" records on motion but motion detection is disabled`,
        );
      }
      const candidates = volumes.filter((volume) => volumeAccepts(volume, camera.id));
      if (volumes.length === 0) {
        error(
          'storage.volumes',
          'no-volume',
          `camera "${camera.id}" records but no storage volume is configured`,
        );
      } else if (candidates.length === 0) {
        error(
          path,
          'no-volume-for-camera',
          `camera "${camera.id}" records but no volume accepts it (check volume cameraIds)`,
        );
      } else if (!recording?.profile && !config.streaming.defaults?.record) {
        error(`${path}.recording`, 'no-record-profile', 'no recording profile configured');
      }

      const recordProfileName = recording?.profile ?? config.streaming.defaults?.record;
      const recordProfile = recordProfileName ? profiles[recordProfileName] : undefined;
      if (camera.audio?.enabled && recordProfile?.audio?.codec === 'none') {
        warn(
          `${path}.audio`,
          'audio-dropped',
          `camera audio is enabled but profile "${recordProfileName}" drops audio`,
        );
      }
    }

    for (const issue of zoneMaskIssues(camera.motion?.zones, `${path}.motion.zones`)) {
      error(`${path}.motion.zones`, issue.code, issue.message);
    }
    checkScheduleRefs(camera.ptz?.patrol?.scheduleIds, `${path}.ptz.patrol.scheduleIds`);

    const presetNames = new Set((camera.ptz?.presets ?? []).map((preset) => preset.name));
    for (const [patrolIndex, preset] of (camera.ptz?.patrol?.presets ?? []).entries()) {
      if (!presetNames.has(preset)) {
        error(
          `${path}.ptz.patrol.presets[${patrolIndex}]`,
          'unknown-preset',
          `PTZ patrol references unknown preset "${preset}"`,
        );
      }
    }

    if (camera.ai?.enabled) {
      if (!config.ai.enabled) {
        warn(`${path}.ai`, 'ai-disabled', `camera "${camera.id}" enables AI but ai.enabled is false`);
      }
      if (!camera.ai.providerId) {
        error(`${path}.ai.providerId`, 'no-ai-provider', `camera "${camera.id}" enables AI without a providerId`);
      } else if (!providerIds.has(camera.ai.providerId)) {
        error(
          `${path}.ai.providerId`,
          'unknown-ai-provider',
          `camera "${camera.id}" references unknown AI provider "${camera.ai.providerId}"`,
        );
      }
      if ((camera.ai.labels ?? []).length === 0) {
        warn(
          `${path}.ai.labels`,
          'ai-all-labels',
          `camera "${camera.id}" has no label filter; every detection will raise an event`,
        );
      }
    }

    if ((camera.streams.main.type === 'rtsp' || camera.streams.main.type === 'onvif') && !camera.streams.main.credentials?.password) {
      warn(
        `${path}.streams.main.credentials`,
        'missing-camera-password',
        `camera "${camera.id}" has no password configured for its ${camera.streams.main.type} source`,
      );
    }

    for (const [maskIndex, mask] of (camera.privacyMasks ?? []).entries()) {
      if (mask.x + mask.width > 1.0001 || mask.y + mask.height > 1.0001) {
        error(
          `${path}.privacyMasks[${maskIndex}]`,
          'mask-out-of-bounds',
          'privacy mask extends beyond the normalized frame (x+width and y+height must be <= 1)',
        );
      }
    }
  }

  for (const issue of zoneMaskIssues(config.motion.zones, 'motion.zones')) {
    error('motion.zones', issue.code, issue.message);
  }

  // ---- layouts ------------------------------------------------------------
  const layouts = config.layouts ?? [];
  const defaultLayouts = layouts.filter((layout) => layout.isDefault);
  if (defaultLayouts.length > 1) {
    error('layouts', 'multiple-defaults', 'more than one layout is marked isDefault');
  }
  if (layouts.length > 0 && defaultLayouts.length === 0) {
    warn('layouts', 'no-default-layout', 'no layout is marked isDefault; the first layout will be used');
  }
  for (const [index, layout] of layouts.entries()) {
    for (const [tileIndex, tile] of (layout.tiles ?? []).entries()) {
      const tilePath = `layouts[${index}].tiles[${tileIndex}]`;
      if (!cameraById.has(tile.cameraId)) {
        error(`${tilePath}.cameraId`, 'unknown-camera', `layout references unknown camera "${tile.cameraId}"`);
      }
      const width = tile.width ?? 1;
      const height = tile.height ?? 1;
      if (tile.x + width > layout.columns || tile.y + height > layout.rows) {
        error(
          tilePath,
          'tile-out-of-bounds',
          `tile (${tile.x},${tile.y} ${width}x${height}) exceeds the ${layout.columns}x${layout.rows} grid`,
        );
      }
    }
    const tiles = layout.tiles ?? [];
    for (let a = 0; a < tiles.length; a += 1) {
      for (let b = a + 1; b < tiles.length; b += 1) {
        const first = tiles[a]!;
        const second = tiles[b]!;
        const firstW = first.width ?? 1;
        const firstH = first.height ?? 1;
        const secondW = second.width ?? 1;
        const secondH = second.height ?? 1;
        if (
          first.x < second.x + secondW &&
          second.x < first.x + firstW &&
          first.y < second.y + secondH &&
          second.y < first.y + firstH
        ) {
          warn(
            `layouts[${index}].tiles[${b}]`,
            'overlapping-tiles',
            `tiles for "${first.cameraId}" and "${second.cameraId}" overlap`,
          );
        }
      }
    }
  }

  // ---- AI -----------------------------------------------------------------
  for (const [index, provider] of providers.entries()) {
    if (provider.type === 'plugin') {
      if (!(config.plugins.trustedPlugins ?? []).includes(provider.pluginId)) {
        warn(
          `ai.providers[${index}].pluginId`,
          'untrusted-plugin',
          `plugin "${provider.pluginId}" is not in plugins.trustedPlugins and will not load`,
        );
      }
    }
  }
  checkProviderRef(config.ai.defaultProviderId, 'ai.defaultProviderId');

  function checkProviderRef(id: string | undefined, path: string) {
    if (id !== undefined && !providerIds.has(id)) {
      error(path, 'unknown-ai-provider', `unknown AI provider "${id}"`);
    }
  }

  // ---- rules & notifications ---------------------------------------------
  if (channelIds.size !== channels.length) {
    // duplicate ids are reported by uniqueIds above; nothing else to do here.
  }
  for (const [index, rule] of (config.rules ?? []).entries()) {
    const path = `rules[${index}]`;
    for (const cameraId of rule.when.cameraIds ?? []) {
      if (!cameraById.has(cameraId)) {
        error(`${path}.when.cameraIds`, 'unknown-camera', `rule "${rule.id}" references unknown camera "${cameraId}"`);
      }
    }
    checkScheduleRefs(rule.when.scheduleIds, `${path}.when.scheduleIds`);
    checkScheduleRefs(rule.when.outsideScheduleIds, `${path}.when.outsideScheduleIds`);
    for (const channelId of rule.then.notify?.channels ?? []) {
      if (!channelIds.has(channelId)) {
        error(
          `${path}.then.notify.channels`,
          'unknown-channel',
          `rule "${rule.id}" references unknown notification channel "${channelId}"`,
        );
      } else if (channels.find((channel) => channel.id === channelId)?.enabled === false) {
        warn(
          `${path}.then.notify.channels`,
          'channel-disabled',
          `rule "${rule.id}" notifies channel "${channelId}", which is disabled`,
        );
      }
    }
    checkProfileRef(rule.then.record?.profile, `${path}.then.record.profile`);
    if (rule.then.ptz) {
      const targetId = rule.then.ptz.cameraId ?? rule.when.cameraIds?.[0];
      if (!targetId) {
        warn(`${path}.then.ptz`, 'ptz-no-camera', 'PTZ action has no cameraId and the rule matches multiple cameras');
      } else {
        const target = cameraById.get(targetId);
        if (!target) {
          error(`${path}.then.ptz.cameraId`, 'unknown-camera', `unknown camera "${targetId}"`);
        } else if (!(target.ptz?.presets ?? []).some((preset) => preset.name === rule.then.ptz?.preset)) {
          error(
            `${path}.then.ptz.preset`,
            'unknown-preset',
            `camera "${targetId}" has no PTZ preset "${rule.then.ptz.preset}"`,
          );
        }
      }
    }
    for (const providerId of rule.when.ai?.providerIds ?? []) {
      if (!providerIds.has(providerId)) {
        error(`${path}.when.ai.providerIds`, 'unknown-ai-provider', `unknown AI provider "${providerId}"`);
      }
    }
    const aiEvents = (rule.when.events ?? []).filter((event) => event.startsWith('ai.'));
    if (aiEvents.length > 0 && !config.ai.enabled) {
      warn(path, 'ai-rule-disabled', `rule "${rule.id}" matches AI events but ai.enabled is false`);
    }
    if (rule.enabled !== false && Object.keys(rule.then).length === 0) {
      warn(`${path}.then`, 'no-actions', `rule "${rule.id}" has no actions`);
    }
  }

  // ---- plugins ------------------------------------------------------------
  if (config.plugins.enabled === false && (config.plugins.trustedPlugins ?? []).length > 0) {
    warn('plugins', 'plugins-disabled', 'plugins are disabled; trustedPlugins will not load');
  }

  return issues;
}

export function assertSemantics(config: ResolvedIcamifyConfig): ConfigIssue[] {
  const issues = checkSemantics(config);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    class ConfigSemanticError extends Error {
      readonly issues: ConfigIssue[];

      constructor(issues: ConfigIssue[]) {
        super(`configuration failed integrity checks (${errors.length} error${errors.length === 1 ? '' : 's'})`);
        this.name = 'ConfigSemanticError';
        this.issues = issues;
      }
    }
    throw new ConfigSemanticError(errors);
  }
  return issues;
}

/** Convenience for callers that only have the on-disk shape. */
export type PartialConfig = IcamifyConfig;
