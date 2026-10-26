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
  recording: { mode: string; enabled: boolean; segmentMinutes?: number };
  motion: { enabled: boolean };
  ai: { enabled: boolean; providerId?: string; labels: string[] };
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
