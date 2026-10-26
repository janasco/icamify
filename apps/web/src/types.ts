/** Types mirrored from the server API. Kept hand-written so the console has no build-time coupling. */

export interface TransportAvailability {
  transport: 'webrtc' | 'mse' | 'hls' | 'mjpeg';
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface LiveSessionStats {
  cameraId: string;
  transport: 'mse' | 'mjpeg';
  state: 'idle' | 'running' | 'restarting' | 'closed';
  viewers: number;
  fragments: number;
  bytes: number;
  restarts: number;
  codec?: string;
  width?: number;
  height?: number;
  lastError?: string;
}

export interface CameraStatus {
  state: 'idle' | 'live' | 'restarting' | 'offline';
  viewers: number;
  sessions: LiveSessionStats[];
  transports: TransportAvailability[];
  lastError?: string;
}

export interface CameraView {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  groupIds: string[];
  tags: string[];
  profiles: { record?: string; live?: string; detect?: string };
  recording: {
    mode: string;
    enabled: boolean;
    segmentMinutes?: number;
    state?: string;
    directToDisk?: boolean;
    eventActive?: boolean;
    bufferedSeconds?: number;
    adoptedSegments?: number;
    lastError?: string;
  };
  motion: {
    enabled: boolean;
    active?: boolean;
    sensitivity?: number;
    lastPercent?: number;
    lastMotionAt?: number;
    lastError?: string;
  };
  ai: {
    enabled: boolean;
    providerId?: string;
    providerName?: string;
    task?: string;
    labels: string[];
    minConfidence?: number;
    lastLabels?: string[];
    lastDetectionAt?: number;
    lastLatencyMs?: number;
    lastError?: string;
    circuit?: 'closed' | 'open' | 'unknown';
  };
  ptz: { supported: boolean };
  hasSubStream: boolean;
  source: { type: string; label: string; masked: string };
  snapshotUrl: string;
  liveUrl: string;
  mjpegUrl: string;
  ui: { order?: number; accentColor?: string };
  status: CameraStatus;
}

export interface LayoutTile {
  cameraId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  stream?: 'sub' | 'main';
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

export interface AuthUser {
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  kind?: string;
  displayName?: string;
}

export interface AuthMe {
  authenticated: boolean;
  user: AuthUser | null;
  auth: {
    mode: 'none' | 'local';
    signInRequired: boolean;
    allowAnonymousViewing: boolean;
    userCount: number;
  };
}

export interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  startedAt: string;
  timezone: string;
  ffmpeg: { version: string; encoders: string[]; demuxers: string[] } | null;
  transports: {
    ladder: string[];
    availability: TransportAvailability[];
    webrtc: { enabled: boolean; available: boolean; reason?: string; fallbackAfterMs: number };
  };
  features: Record<string, boolean>;
}

export interface CameraList {
  cameras: CameraView[];
}

export interface LayoutList {
  layouts: LayoutConfig[];
  defaultLayoutId?: string;
  cameras: Array<{ id: string; name: string; order: number }>;
}

/** Detection boxes in 0..1 image coordinates, as pushed over the control socket. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized?: true;
}

/** Live motion episode for a camera (WebSocket `motion` message). */
export interface MotionRuntime {
  cameraId: string;
  active: boolean;
  at: number;
  percent: number;
  peakPercent?: number;
  boxes?: NormalizedBox[];
}

export interface MotionStatus {
  cameraId: string;
  enabled: boolean;
  running: boolean;
  state: 'idle' | 'starting' | 'running' | 'stalled' | 'error';
  analysis: { width: number; height: number; fps: number; pixelFormat: 'gray' | 'rgb24' };
  settings: {
    sensitivity: number;
    intervalMs: number;
    postMotionSeconds: number;
    minBlobPercent: number;
    denoise: number;
    blurRadius: number;
    colorFilter: boolean;
  };
  thresholds: { threshold: number; percentThreshold: number; sensitivity: number; derivedFromSensitivity: boolean };
  zones: { cols: number; rows: number; mode: 'include' | 'exclude'; cells: boolean[][] };
  activeCells: number;
  totalCells: number;
  motion: boolean;
  lastPercent: number;
  peakPercent: number;
  lastMotionAt?: number;
  lastFrameAt?: number;
  frames: number;
  analysed: number;
  boxes: NormalizedBox[];
  lastError?: string;
}

export interface RecordingSegment {
  id: string;
  cameraId: string;
  volumeId: string;
  path: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  reason: 'continuous' | 'motion' | 'alert' | 'scheduled' | 'manual';
  hasMotion: boolean;
  hasAlert: boolean;
  eventIds: string[];
  protected?: boolean;
}

export interface RecordedEvent {
  id: string;
  cameraId: string;
  kind: string;
  startedAt: number;
  endedAt?: number;
  peakPercent?: number;
  label?: string;
  confidence?: number;
  providerId?: string;
  snapshot?: string;
}

/** One live detection pushed over the control socket (`ai` message). */
export interface AiDetection {
  label: string;
  confidence: number;
  box?: NormalizedBox;
}

export interface AiRuntime {
  cameraId: string;
  at: number;
  task: string;
  providerId: string;
  detections: AiDetection[];
  latencyMs?: number;
}

/** A rule that fired (`alert` message). */
export interface AlertRuntime {
  ruleId: string;
  ruleName: string;
  cameraId: string;
  at: number;
  kind: string;
  label?: string;
  confidence?: number;
  actions: Array<{ action: string; ok: boolean; detail?: string }>;
  snapshot?: string;
  eventId?: string;
}

export interface AiStatus {
  cameraId: string;
  enabled: boolean;
  providerId?: string;
  providerName?: string;
  task: 'object' | 'face' | 'lpr' | 'scene';
  capabilities: string[];
  labels: string[];
  minConfidence: number;
  intervalMs: number;
  cropToMotion: boolean;
  saveSnapshots: boolean;
  analyses: number;
  detections: number;
  lastDetectionAt?: number;
  lastLatencyMs?: number;
  lastLabels: string[];
  lastError?: string;
  circuit: 'closed' | 'open' | 'unknown';
}

export interface AiStatusResponse {
  cameraId: string;
  ai: AiStatus | null;
}

export interface AiDetectionResult {
  cameraId: string;
  at: number;
  task: string;
  providerId: string;
  detections: AiDetection[];
  latencyMs: number;
  snapshot?: string;
  eventIds?: string[];
  reason?: string;
  ai?: AiStatus | null;
}

export interface EventList {
  events: RecordedEvent[];
}

export interface RecordingList {
  segments: RecordingSegment[];
  total: number;
  stats: { segments: number; bytes: number; oldestAt?: number; newestAt?: number };
}

export interface MotionResponse {
  cameraId: string;
  motion: MotionStatus | null;
}
