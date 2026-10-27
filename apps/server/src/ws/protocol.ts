import type { Role } from '@icamify/core';
import type { RecordedEvent, RecordingSegment, RetentionSweepResult } from '@icamify/storage';
import type { NormalizedBox } from '../motion/service.ts';
import type { CameraView } from '../runtime.ts';
import type { IceCandidateInit } from '../webrtc/signaling.ts';

/**
 * Control-channel protocol.
 *
 * Every message is JSON with a `type` tag. Binary frames are reserved for the
 * per-camera media socket (`/api/cameras/:id/live.ws`), so the control channel
 * stays trivially auditable and can be rate-limited by message count.
 */

export type ClientMessage =
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping'; t?: number }
  | { type: 'webrtc:offer'; cameraId: string; sdp: string }
  | { type: 'webrtc:ice'; sessionId: string; candidate: IceCandidateInit }
  | { type: 'webrtc:close'; sessionId: string };

export interface WelcomeMessage {
  type: 'welcome';
  user: { username: string; role: Role; kind: string } | null;
  server: { version: string; uptimeSeconds: number; startedAt: string };
  cameras: CameraView[];
  topics: string[];
}

export type ServerMessage =
  | WelcomeMessage
  | { type: 'pong'; t?: number }
  | { type: 'subscribed'; topics: string[] }
  | { type: 'cameras'; cameras: CameraView[] }
  | { type: 'camera:status'; camera: CameraView }
  | {
      type: 'motion';
      cameraId: string;
      /** True once an episode starts; false when it ends. */
      active: boolean;
      at: number;
      percent: number;
      peakPercent?: number;
      /** Detection boxes in 0..1 image coordinates. */
      boxes?: NormalizedBox[];
    }
  | { type: 'recording:segment'; segment: RecordingSegment }
  | { type: 'recording:event'; event: RecordedEvent; closed: boolean }
  | {
      type: 'ai';
      cameraId: string;
      at: number;
      task: string;
      providerId: string;
      latencyMs: number;
      detections: Array<{ label: string; confidence: number; box?: NormalizedBox }>;
      snapshot?: string;
    }
  | { type: 'ai:error'; cameraId: string; at: number; message: string }
  | {
      type: 'alert';
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
  | { type: 'storage:sweep'; volumes: RetentionSweepResult[] }
  | {
      type: 'storage:warning';
      volumeId: string;
      message: string;
      freeBytes: number;
      freePercent: number;
    }
  | { type: 'storage:prune'; snapshotsRemoved: number; eventsRemoved: number; bytesFreed: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'webrtc:answer'; sessionId: string; cameraId: string; sdp: string }
  | { type: 'webrtc:error'; code: string; message: string };

export const CONTROL_TOPICS = ['cameras'] as const;
export type ControlTopic = (typeof CONTROL_TOPICS)[number];

export function parseClientMessage(raw: string): ClientMessage | { type: 'invalid'; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: 'invalid', message: 'Messages must be JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { type: 'invalid', message: 'Messages must be JSON objects.' };
  }
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case 'subscribe':
    case 'unsubscribe': {
      if (!Array.isArray(message.topics) || message.topics.some((topic) => typeof topic !== 'string')) {
        return { type: 'invalid', message: 'topics must be an array of strings.' };
      }
      return { type: message.type, topics: message.topics as string[] };
    }
    case 'ping':
      return typeof message.t === 'number' ? { type: 'ping', t: message.t } : { type: 'ping' };
    case 'webrtc:offer':
      if (typeof message.cameraId !== 'string' || typeof message.sdp !== 'string') {
        return { type: 'invalid', message: 'webrtc:offer needs cameraId and sdp strings.' };
      }
      return { type: 'webrtc:offer', cameraId: message.cameraId, sdp: message.sdp };
    case 'webrtc:ice': {
      if (typeof message.sessionId !== 'string' || typeof message.candidate !== 'object' || message.candidate === null) {
        return { type: 'invalid', message: 'webrtc:ice needs sessionId and a candidate object.' };
      }
      return { type: 'webrtc:ice', sessionId: message.sessionId, candidate: message.candidate as IceCandidateInit };
    }
    case 'webrtc:close':
      if (typeof message.sessionId !== 'string') {
        return { type: 'invalid', message: 'webrtc:close needs a sessionId.' };
      }
      return { type: 'webrtc:close', sessionId: message.sessionId };
    default:
      return { type: 'invalid', message: `Unknown message type "${String(message.type)}".` };
  }
}
