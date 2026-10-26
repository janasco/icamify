import type { Credentials, PtzPreset } from '@icamify/core';

/**
 * ONVIF contracts (Phase 4).
 *
 * Discovery is a plain WS-Discovery SOAP probe over UDP multicast; no native
 * module is required. PTZ uses Profile S SOAP calls (ContinuousMove,
 * AbsoluteMove, GotoPreset, GetPresets).
 */

export interface DiscoveredDevice {
  urn: string;
  /** Advertised XAddrs (device service endpoint). */
  xaddr: string;
  host: string;
  port?: number;
  name?: string;
  hardware?: string;
  location?: string;
  scopes: string[];
  discoveredAt: number;
}

export interface MediaProfile {
  token: string;
  name: string;
  width?: number;
  height?: number;
  encoding?: string;
  fps?: number;
  bitrateKbps?: number;
}

export interface DeviceInfo {
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  serialNumber?: string;
}

export interface OnvifDeviceClient {
  readonly host: string;
  deviceInfo(): Promise<DeviceInfo>;
  mediaProfiles(): Promise<MediaProfile[]>;
  streamUri(profileToken?: string): Promise<string>;
  snapshotUri(profileToken?: string): Promise<string>;
  presets(): Promise<PtzPreset[]>;
}

export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}

export interface PtzClient {
  continuousMove(vector: Partial<PtzVector>, durationMs: number): Promise<void>;
  absoluteMove(vector: Partial<PtzVector>): Promise<void>;
  stop(): Promise<void>;
  gotoPreset(name: string): Promise<void>;
  presetNames(): Promise<string[]>;
}

export interface DiscoveryOptions {
  subnets?: string[];
  multicastAddress?: string;
  multicastPort?: number;
  timeoutMs?: number;
  credentials?: Credentials;
}

/** Starts a scan and resolves with every device that answered. */
export type OnvifScanner = (options: DiscoveryOptions) => Promise<DiscoveredDevice[]>;
