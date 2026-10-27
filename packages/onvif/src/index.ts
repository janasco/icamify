import type { PtzPreset } from '@icamify/core';
import type { DiscoveryRunOptions } from './discovery.ts';

/**
 * ONVIF contracts.
 *
 * Discovery is a plain WS-Discovery SOAP probe over UDP multicast; no native
 * module is required. PTZ uses Profile S SOAP calls (ContinuousMove,
 * AbsoluteMove, GotoPreset, GetPresets, Stop).
 *
 * What this package deliberately does not do: profile G media, events
 * subscriptions, imaging controls and analytics. Profile S is what Cloud PTZ
 * cameras expose, and the rest would be surface area with no consumer.
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
  credentials?: { username?: string; password?: string };
}

/** Starts a scan and resolves with every device that answered. */
export type OnvifScanner = (options: DiscoveryOptions) => Promise<DiscoveredDevice[]>;

export { OnvifError, type OnvifErrorCode } from './errors.ts';
export {
  DEFAULT_MULTICAST_ADDRESS,
  DEFAULT_MULTICAST_PORT,
  buildProbeMessage,
  datagramTransport,
  discoverDevices,
  parseProbeMatches,
  parseScopes,
  type DiscoveryRunOptions,
  type DiscoveryTransport,
  type DiscoveryTransportFactory,
  type OnvifScopes,
} from './discovery.ts';
export {
  OnvifClient,
  deriveServiceUrls,
  digestAuthorization,
  parseDigestChallenge,
  type DigestChallenge,
  type OnvifClientOptions,
} from './client.ts';
export {
  NAMESPACES,
  absoluteMoveRequest,
  continuousMoveRequest,
  deviceInformationRequest,
  getCapabilitiesRequest,
  getPresetsRequest,
  getProfilesRequest,
  getSnapshotUriRequest,
  getStatusRequest,
  getStreamUriRequest,
  gotoPresetRequest,
  isoDuration,
  passwordDigest,
  soapEnvelope,
  soapFaultReason,
  stopRequest,
  wsSecurityHeader,
  type VectorInput,
  type WsSecurityOptions,
} from './soap.ts';
export {
  attribute,
  decodeXmlEntities,
  escapeXml,
  findAll,
  findFirst,
  localName,
  mapAll,
  parseXml,
  text,
  textOf,
  type XmlNode,
} from './xml.ts';

/** One scan with warnings surfaced, for the API's "discover" action. */
export type DiscoveryRunner = (options?: DiscoveryRunOptions) => Promise<DiscoveredDevice[]>;

export const ONVIF_VERSION = '0.1.0';
