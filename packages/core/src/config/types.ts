/**
 * TypeScript view of config/icamify.schema.json.
 *
 * The JSON Schema is the normative contract (it is what the editor validates and
 * what `icamify config validate` enforces); these types keep the runtime honest.
 * All sections are optional on disk because the loader merges them over
 * DEFAULT_CONFIG, which is why the loader returns `ResolvedIcamifyConfig`.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type Role = 'admin' | 'operator' | 'viewer';
export type StreamKind = 'main' | 'sub';
export type Transport = 'tcp' | 'udp' | 'auto';
export type RecordingMode = 'off' | 'continuous' | 'motion' | 'alert' | 'scheduled';
export type MotionZoneMode = 'include' | 'exclude';
export type AiCapability = 'object' | 'face' | 'lpr' | 'scene';
export type EventKind =
  | 'motion'
  | 'ai.object'
  | 'ai.face'
  | 'ai.lpr'
  | 'camera.online'
  | 'camera.offline'
  | 'storage.warning'
  | 'storage.critical';
export type Severity = 'info' | 'warning' | 'critical';

export interface SystemConfig {
  server?: {
    host?: string;
    port?: number;
    publicUrl?: string;
    trustProxy?: boolean;
  };
  tls?: {
    enabled?: boolean;
    certFile?: string;
    keyFile?: string;
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
  };
  logging?: {
    level?: LogLevel;
    file?: string;
    maxFileMb?: number;
    maxFiles?: number;
    pretty?: boolean;
    redactSecrets?: boolean;
  };
  timezone?: string;
  workers?: { motion?: number; ai?: number; thumbnail?: number };
  shutdownGraceSeconds?: number;
  healthCheckSeconds?: number;
  api?: {
    basePath?: string;
    corsOrigins?: string[];
    rateLimit?: { windowMs?: number; max?: number };
    websocket?: { path?: string; heartbeatSeconds?: number; maxClients?: number };
  };
  web?: { serveStatic?: boolean; staticDir?: string };
}

export interface AuthConfig {
  mode?: 'none' | 'local';
  allowAnonymousViewing?: boolean;
  session?: {
    secret?: string;
    cookieName?: string;
    ttlHours?: number;
    idleTimeoutMinutes?: number;
    secureCookie?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
  };
  users?: Array<{
    id?: string;
    username: string;
    displayName?: string;
    role: Role;
    passwordHash: string;
    enabled?: boolean;
  }>;
  apiTokens?: Array<{
    id?: string;
    name: string;
    tokenHash: string;
    role: Role;
    expiresAt?: string;
  }>;
  lockout?: { maxAttempts?: number; windowMinutes?: number; blockMinutes?: number };
}

export interface Credentials {
  username?: string;
  password?: string;
}

export interface RtspSource {
  type: 'rtsp';
  url: string;
  transport?: Transport;
  credentials?: Credentials;
  timeoutSeconds?: number;
}

export interface RtmpSource {
  type: 'rtmp';
  url: string;
  live?: boolean;
  timeoutSeconds?: number;
}

export interface HttpSource {
  type: 'http';
  url: string;
  format?: 'auto' | 'mjpeg' | 'h264' | 'h265';
  auth?: 'none' | 'basic' | 'digest';
  credentials?: Credentials;
  snapshotUrl?: string;
  timeoutSeconds?: number;
}

export interface OnvifSource {
  type: 'onvif';
  host: string;
  port?: number;
  credentials?: Credentials;
  profileToken?: string;
  streamUriOverride?: string;
}

export interface UsbSource {
  type: 'usb';
  device: string;
  inputFormat?: 'v4l2' | 'dshow' | 'avfoundation';
  resolution?: { width?: number; height?: number };
  fps?: number;
  pixelFormat?: string;
}

export interface FileSource {
  type: 'file';
  path: string;
  loop?: boolean;
  realtime?: boolean;
  startSeconds?: number;
}

export type StreamSource =
  | RtspSource
  | RtmpSource
  | HttpSource
  | OnvifSource
  | UsbSource
  | FileSource;

export interface StreamProfile {
  description?: string;
  purpose?: 'record' | 'live' | 'detect';
  copy?: boolean;
  video: {
    codec: 'copy' | 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'mjpeg';
    width?: number;
    height?: number;
    fps?: number;
    bitrateKbps?: number;
    maxBitrateKbps?: number;
    gopSeconds?: number;
    preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
    profile?: 'baseline' | 'main' | 'high';
    pixelFormat?: 'yuv420p' | 'yuvj420p' | 'nv12';
    hardwareAcceleration?: 'none' | 'auto' | 'vaapi' | 'nvenc' | 'qsv' | 'videotoolbox';
    bframes?: number;
    rotation?: 0 | 90 | 180 | 270;
  };
  audio?: {
    codec?: 'copy' | 'aac' | 'opus' | 'none';
    bitrateKbps?: number;
    sampleRate?: 8000 | 16000 | 22050 | 44100 | 48000;
    channels?: 1 | 2;
  };
  container?: 'mkv' | 'mp4' | 'fmp4' | 'webm' | 'mpegts';
  latency?: 'low' | 'balanced' | 'quality';
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type LiveTransport = 'webrtc' | 'mse' | 'hls' | 'mjpeg';

export interface StreamingConfig {
  profiles?: Record<string, StreamProfile>;
  defaults?: { record?: string; live?: string; detect?: string };
  webrtc?: {
    enabled?: boolean;
    iceServers?: IceServer[];
    portRange?: { min?: number; max?: number };
    publicIp?: string;
    codecPreference?: Array<'h264' | 'vp8' | 'vp9' | 'av1'>;
    maxBitrateKbps?: number;
    maxViewersPerCamera?: number;
    fallbackAfterMs?: number;
  };
  mse?: { enabled?: boolean; segmentDurationMs?: number; windowSegments?: number };
  hls?: { enabled?: boolean; segmentSeconds?: number; playlistSize?: number };
  mjpeg?: { enabled?: boolean; fps?: number; width?: number; quality?: number };
  fallbackChain?: LiveTransport[];
  maxConcurrentSessions?: number;
  sessionIdleTimeoutSeconds?: number;
  onDemandStart?: boolean;
}

export interface MotionZones {
  cols?: number;
  rows?: number;
  /** Bitmap: '/'-separated rows of '1' (active) and '0' (ignored). */
  cells?: string;
  mode?: MotionZoneMode;
}

export interface MotionSettings {
  enabled?: boolean;
  intervalMs?: number;
  sensitivity?: number;
  threshold?: number;
  percentThreshold?: number;
  minBlobPercent?: number;
  blurRadius?: number;
  grayscale?: boolean;
  denoise?: number;
  colorFilter?: {
    enabled?: boolean;
    minSaturation?: number;
    hueRanges?: Array<{ from: number; to: number }>;
  };
  zones?: MotionZones;
  cooldownSeconds?: number;
  warmupFrames?: number;
  postMotionSeconds?: number;
}

export interface RecordingConfig {
  enabled?: boolean;
  mode?: RecordingMode;
  profile?: string;
  preBufferSeconds?: number;
  postRollSeconds?: number;
  segmentMinutes?: number;
  scheduleIds?: string[];
  audio?: boolean;
  maxFileSizeMb?: number;
  maxDurationMinutes?: number;
}

export interface CameraAiConfig {
  enabled?: boolean;
  providerId?: string;
  labels?: string[];
  minConfidence?: number;
  intervalMs?: number;
  cropToMotion?: boolean;
  saveSnapshots?: boolean;
  snapshotOnAlert?: boolean;
}

export interface PtzPreset {
  name: string;
  pan?: number;
  tilt?: number;
  zoom?: number;
  token?: string;
}

export interface PtzConfig {
  enabled?: boolean;
  profileToken?: string;
  presets?: PtzPreset[];
  patrol?: {
    enabled?: boolean;
    presets?: string[];
    dwellSeconds?: number;
    randomize?: boolean;
    scheduleIds?: string[];
  };
}

/** Restart/watchdog policy for a camera's ingest pipelines. */
export interface CameraHealthOptions {
  probeIntervalSeconds?: number;
  offlineAfterFailures?: number;
  restartBackoffSeconds?: number;
  maxBackoffSeconds?: number;
}

export interface CameraConfig {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  groupIds?: string[];
  tags?: string[];
  streams: { main: StreamSource; sub?: StreamSource };
  profiles?: { record?: string; live?: string; detect?: string };
  recording?: RecordingConfig;
  motion?: MotionSettings;
  ai?: CameraAiConfig;
  ptz?: PtzConfig;
  audio?: { enabled?: boolean; gainDb?: number };
  overlay?: {
    enabled?: boolean;
    timestamp?: boolean;
    cameraName?: boolean;
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    fontSize?: number;
  };
  privacyMasks?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  }>;
  health?: CameraHealthOptions;
  ui?: { order?: number; accentColor?: string };
}

export interface StorageVolume {
  id: string;
  path: string;
  maxSizeGb?: number;
  maxAgeHours?: number;
  minFreeDiskGb?: number;
  priority?: number;
  cameraIds?: string[];
  archive?: {
    enabled?: boolean;
    providerId?: string;
    afterHours?: number;
    keepLocalDays?: number;
  };
}

export interface ArchiveS3 {
  id: string;
  type: 's3';
  enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  storageClass?: 'STANDARD' | 'STANDARD_IA' | 'ONEZONE_IA' | 'GLACIER_IR';
  deleteAfterUpload?: boolean;
}

export interface ArchiveSftp {
  id: string;
  type: 'sftp';
  enabled?: boolean;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  remoteDir: string;
  deleteAfterUpload?: boolean;
}

export interface ArchiveLocal {
  id: string;
  type: 'local';
  enabled?: boolean;
  path: string;
  deleteAfterUpload?: boolean;
}

export type ArchiveProvider = ArchiveS3 | ArchiveSftp | ArchiveLocal;

export interface StorageConfig {
  rootDir?: string;
  recordingsDir?: string;
  snapshotsDir?: string;
  stateDir?: string;
  tempDir?: string;
  format?: 'mkv' | 'mp4';
  filenameTemplate?: string;
  segmentMinutes?: number;
  preBufferSeconds?: number;
  preBufferMaxMemoryMb?: number;
  snapshot?: { format?: 'jpg' | 'png'; quality?: number; maxWidth?: number };
  defaultVolume?: string;
  volumes?: StorageVolume[];
  purge?: {
    enabled?: boolean;
    intervalSeconds?: number;
    strategy?: 'oldest-first' | 'largest-first' | 'lowest-priority-first';
    batchSize?: number;
    dryRun?: boolean;
    protectFlagged?: boolean;
  };
  diskHealthCheckSeconds?: number;
  warnAtPercent?: number;
  archiveProviders?: ArchiveProvider[];
}

export interface GroupConfig {
  id: string;
  name: string;
  order?: number;
}

export interface LayoutTile {
  cameraId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  stream?: StreamKind;
  muted?: boolean;
  showOverlay?: boolean;
}

export interface LayoutConfig {
  id: string;
  name: string;
  isDefault?: boolean;
  columns: number;
  rows: number;
  autoFill?: boolean;
  tiles?: LayoutTile[];
}

export interface ScheduleWindow {
  days: Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>;
  start: string;
  end: string;
}

export interface ScheduleConfig {
  id: string;
  name: string;
  timezone?: string;
  windows: ScheduleWindow[];
  exceptions?: Array<{ date: string; closed?: boolean }>;
}

export interface RuleCondition {
  cameraIds?: string[];
  events?: EventKind[];
  ai?: { labels?: string[]; minConfidence?: number; providerIds?: string[] };
  scheduleIds?: string[];
  outsideScheduleIds?: string[];
  minDurationSeconds?: number;
  cooldownSeconds?: number;
}

export interface RuleActions {
  record?: { enabled?: boolean; seconds?: number; profile?: string };
  snapshot?: { enabled?: boolean; annotate?: boolean };
  notify?: {
    channels?: string[];
    severity?: Severity;
    title?: string;
    message?: string;
    attachSnapshot?: boolean;
  };
  ptz?: { cameraId?: string; preset: string };
  script?: { path: string; args?: string[]; timeoutSeconds?: number };
  markEvent?: { label?: string; tags?: string[] };
}

export interface RuleConfig {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  when: RuleCondition;
  then: RuleActions;
}

export interface NotificationChannelBase {
  id: string;
  name: string;
  enabled?: boolean;
  type: 'webhook' | 'email' | 'mqtt' | 'telegram';
}

export interface WebhookChannel extends NotificationChannelBase {
  type: 'webhook';
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  bodyTemplate?: string;
  hmacSecret?: string;
  timeoutMs?: number;
}

export interface EmailChannel extends NotificationChannelBase {
  type: 'email';
  smtp: {
    host: string;
    port?: number;
    secure?: boolean;
    username?: string;
    password?: string;
    from: string;
  };
  to: string[];
  subjectTemplate?: string;
}

export interface MqttChannel extends NotificationChannelBase {
  type: 'mqtt';
  url: string;
  topic: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  username?: string;
  password?: string;
  homeAssistantDiscovery?: boolean;
}

export interface TelegramChannel extends NotificationChannelBase {
  type: 'telegram';
  botToken: string;
  chatId: string;
  parseMode?: 'none' | 'MarkdownV2' | 'HTML';
}

export type NotificationChannel =
  | WebhookChannel
  | EmailChannel
  | MqttChannel
  | TelegramChannel;

export interface NotificationsConfig {
  dedupeSeconds?: number;
  channels?: NotificationChannel[];
}

export interface ProviderCommon {
  id: string;
  name: string;
  enabled?: boolean;
  capabilities?: AiCapability[];
  timeoutMs?: number;
  concurrency?: number;
}

export interface CodeProjectProvider extends ProviderCommon {
  type: 'codeproject-ai';
  url: string;
  apiKey?: string;
  endpoint?: string;
}

export interface DeepStackProvider extends ProviderCommon {
  type: 'deepstack';
  url: string;
  apiKey?: string;
  mode?: 'object' | 'face' | 'scene' | 'lpr';
  minConfidence?: number;
}

export interface GenericHttpProvider extends ProviderCommon {
  type: 'generic-http';
  url: string;
  method?: 'POST' | 'PUT';
  contentType?: 'json' | 'multipart';
  headers?: Record<string, string>;
  requestTemplate?: string;
  response: {
    detectionsPath: string;
    labelPath: string;
    confidencePath: string;
    box: {
      x: string;
      y: string;
      width: string;
      height: string;
      normalized?: boolean;
    };
  };
}

export interface PluginProvider extends ProviderCommon {
  type: 'plugin';
  pluginId: string;
  config?: Record<string, unknown>;
}

export type AiProviderConfig =
  | CodeProjectProvider
  | DeepStackProvider
  | GenericHttpProvider
  | PluginProvider;

export interface AiConfig {
  enabled?: boolean;
  defaultProviderId?: string;
  storeDetectionsDays?: number;
  maxDetectionsPerFrame?: number;
  providers?: AiProviderConfig[];
}

export interface OnvifConfig {
  discovery?: {
    enabled?: boolean;
    intervalSeconds?: number;
    multicastAddress?: string;
    multicastPort?: number;
    subnets?: string[];
    timeoutMs?: number;
  };
  defaults?: { username?: string; password?: string; timeoutMs?: number };
  ptz?: { continuousMoveMs?: number; defaultSpeed?: number };
}

export interface PluginsConfig {
  enabled?: boolean;
  directories?: string[];
  trustedPlugins?: string[];
  timeoutMs?: number;
  workerMemoryMb?: number;
}

export interface IcamifyConfig {
  $schema?: string;
  version: '1.0';
  system?: SystemConfig;
  auth?: AuthConfig;
  storage?: StorageConfig;
  streaming?: StreamingConfig;
  motion?: MotionSettings;
  cameras?: CameraConfig[];
  groups?: GroupConfig[];
  layouts?: LayoutConfig[];
  schedules?: ScheduleConfig[];
  rules?: RuleConfig[];
  notifications?: NotificationsConfig;
  ai?: AiConfig;
  onvif?: OnvifConfig;
  plugins?: PluginsConfig;
}

/** Shape returned by the loader: defaults merged in, so top-level sections exist. */
export interface ResolvedIcamifyConfig extends IcamifyConfig {
  system: SystemConfig;
  auth: AuthConfig;
  storage: StorageConfig;
  streaming: StreamingConfig;
  motion: MotionSettings;
  cameras: CameraConfig[];
  groups: GroupConfig[];
  layouts: LayoutConfig[];
  schedules: ScheduleConfig[];
  rules: RuleConfig[];
  notifications: NotificationsConfig;
  ai: AiConfig;
  onvif: OnvifConfig;
  plugins: PluginsConfig;
}

export type ConfigIssueSeverity = 'error' | 'warning';

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  /** Dotted path, e.g. cameras[2].recording.profile */
  path: string;
  message: string;
  /** JSON Schema keyword or semantic check id. */
  code: string;
}
