import { createHash, randomBytes } from 'node:crypto';
import type { Credentials, PtzPreset } from '@icamify/core';
import { OnvifError } from './errors.ts';
import {
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
  soapEnvelope,
  soapFaultReason,
  stopRequest,
  type VectorInput,
} from './soap.ts';
import type { DeviceInfo, MediaProfile, OnvifDeviceClient, PtzClient, PtzVector } from './index.ts';
import { findFirst, attribute, mapAll, parseXml, textOf, type XmlNode } from './xml.ts';

/**
 * ONVIF device + Profile S PTZ client.
 *
 * Endpoints come from `GetCapabilities` rather than hard-coded guesses, because
 * vendors put media and PTZ on different paths (`/onvif/Media`,
 * `/onvif/media_service`, `/onvif/ptz_service`). If capabilities are unavailable
 * the conventional paths next to the device service are tried.
 *
 * Credentials are used twice: a WS-Security `UsernameToken` in the body, and an
 * HTTP `Digest`/`Basic` answer to a 401. Which one a camera accepts varies by
 * firmware, and doing both costs one round trip in the rare case where the body
 * token is ignored.
 */

export interface OnvifClientOptions {
  host: string;
  port?: number;
  /** Device service path; default `/onvif/device_service`. */
  path?: string;
  credentials?: Credentials;
  timeoutMs?: number;
  /** Injectable for tests; the global fetch is used otherwise. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Disable the WS-Security header for firmware that rejects unknown headers. */
  wsSecurity?: boolean;
  /** Protocol for the service origin; defaults to http. */
  secure?: boolean;
  /** Media profile the device's PTZ service should target. */
  profileToken?: string;
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

const DEFAULT_DEVICE_PATH = '/onvif/device_service';

export function parseDigestChallenge(header: string | null): DigestChallenge | undefined {
  if (header === null || !/^Digest\s/i.test(header)) return undefined;
  const values = new Map<string, string>();
  const pattern = /([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match = pattern.exec(header);
  while (match !== null) {
    values.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? '');
    match = pattern.exec(header);
  }
  const realm = values.get('realm');
  const nonce = values.get('nonce');
  if (realm === undefined || nonce === undefined) return undefined;
  return {
    realm,
    nonce,
    ...(values.get('qop') === undefined ? {} : { qop: values.get('qop') }),
    ...(values.get('opaque') === undefined ? {} : { opaque: values.get('opaque') }),
    ...(values.get('algorithm') === undefined ? {} : { algorithm: values.get('algorithm') }),
  };
}

/** RFC 7616 `auth` response; MD5, which is what ONVIF devices implement. */
export function digestAuthorization(input: {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  uri: string;
  cnonce?: string;
  nc?: string;
}): string {
  const { challenge } = input;
  const cnonce = input.cnonce ?? randomBytes(8).toString('hex');
  const nc = input.nc ?? '00000001';
  const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex');
  const ha1 = md5(`${input.username}:${challenge.realm}:${input.password}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const qop = challenge.qop?.split(',').map((value) => value.trim()).includes('auth') === true;
  const response = qop ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${input.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${input.uri}"`,
    `response="${response}"`,
    ...(challenge.algorithm === undefined ? [] : [`algorithm=${challenge.algorithm}`]),
    ...(challenge.opaque === undefined ? [] : [`opaque="${challenge.opaque}"`]),
    ...(qop ? [`qop=auth`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}

export class OnvifClient implements OnvifDeviceClient, PtzClient {
  readonly host: string;
  readonly endpoint: string;

  private readonly options: OnvifClientOptions;
  private readonly timeoutMs: number;
  private mediaXAddr: string | undefined;
  private ptzXAddr: string | undefined;
  private capabilitiesDone = false;
  private digest: DigestChallenge | undefined;
  private basic = false;

  constructor(options: OnvifClientOptions) {
    this.options = options;
    this.host = options.host;
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 8000);
    const protocol = options.secure === true ? 'https' : 'http';
    const port = options.port === undefined ? '' : `:${options.port}`;
    this.endpoint = `${protocol}://${options.host}${port}${options.path ?? DEFAULT_DEVICE_PATH}`;
  }

  // -- device ---------------------------------------------------------------

  async deviceInfo(): Promise<DeviceInfo> {
    const document = await this.call('device', 'GetDeviceInformation', deviceInformationRequest());
    const info: DeviceInfo = {};
    const manufacturer = textOf(document, 'Manufacturer');
    const model = textOf(document, 'Model');
    const firmwareVersion = textOf(document, 'FirmwareVersion');
    const serialNumber = textOf(document, 'SerialNumber');
    if (manufacturer !== undefined) info.manufacturer = manufacturer;
    if (model !== undefined) info.model = model;
    if (firmwareVersion !== undefined) info.firmwareVersion = firmwareVersion;
    if (serialNumber !== undefined) info.serialNumber = serialNumber;
    return info;
  }

  async mediaProfiles(): Promise<MediaProfile[]> {
    const document = await this.call('media', 'GetProfiles', getProfilesRequest());
    return mapAll(document, 'Profiles', (node) => {
      const token = attribute(node, 'token');
      if (token === undefined) return undefined;
      const encoder = findFirst(node, 'VideoEncoderConfiguration');
      const resolution = findFirst(encoder ?? node, 'Resolution');
      const rate = findFirst(encoder ?? node, 'RateControl');
      const width = number(textOf(resolution, 'Width'));
      const height = number(textOf(resolution, 'Height'));
      const fps = number(textOf(rate, 'FrameRateLimit'));
      const bitrateKbps = number(textOf(rate, 'BitrateLimit'));
      const encoding = textOf(encoder ?? node, 'Encoding');
      return {
        token,
        name: textOf(node, 'Name') ?? token,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(encoding === undefined ? {} : { encoding }),
        ...(fps === undefined ? {} : { fps }),
        ...(bitrateKbps === undefined ? {} : { bitrateKbps }),
      } satisfies MediaProfile;
    });
  }

  async streamUri(profileToken?: string): Promise<string> {
    const token = profileToken ?? (await this.firstProfileToken());
    const document = await this.call('media', 'GetStreamUri', getStreamUriRequest(token));
    const uri = textOf(document, 'Uri');
    if (uri === undefined) {
      throw new OnvifError('protocol', `The device returned no stream URI for profile "${token}".`);
    }
    return uri;
  }

  async snapshotUri(profileToken?: string): Promise<string> {
    const token = profileToken ?? (await this.firstProfileToken());
    const document = await this.call('media', 'GetSnapshotUri', getSnapshotUriRequest(token));
    const uri = textOf(document, 'Uri');
    if (uri === undefined) {
      throw new OnvifError('unsupported', 'The device does not expose a snapshot URI.');
    }
    return uri;
  }

  // -- PTZ ------------------------------------------------------------------

  async presets(): Promise<PtzPreset[]> {
    const token = await this.ptzProfileToken();
    const document = await this.call('ptz', 'GetPresets', getPresetsRequest(token));
    return mapAll(document, 'Preset', (node) => {
      const tokenValue = attribute(node, 'token');
      if (tokenValue === undefined) return undefined;
      const name = textOf(node, 'Name') ?? tokenValue;
      return { name, token: tokenValue };
    });
  }

  async presetNames(): Promise<string[]> {
    return (await this.presets()).map((preset) => preset.name);
  }

  async gotoPreset(name: string): Promise<void> {
    const presets = await this.presets();
    const preset = presets.find((candidate) => candidate.name === name || candidate.token === name);
    if (preset === undefined) {
      throw new OnvifError(
        'invalid-target',
        `The camera has no preset named "${name}".`,
        presets.length === 0 ? { detail: 'the device reported no presets' } : { detail: presets.map((entry) => entry.name).join(', ') },
      );
    }
    await this.gotoPresetToken(preset.token ?? name);
  }

  async gotoPresetToken(token: string): Promise<void> {
    const profileToken = await this.ptzProfileToken();
    await this.call('ptz', 'GotoPreset', gotoPresetRequest(profileToken, token));
  }

  async continuousMove(vector: Partial<PtzVector>, durationMs: number): Promise<void> {
    const profileToken = await this.ptzProfileToken();
    await this.call('ptz', 'ContinuousMove', continuousMoveRequest(profileToken, toVectorInput(vector), durationMs));
  }

  async absoluteMove(vector: Partial<PtzVector>): Promise<void> {
    const profileToken = await this.ptzProfileToken();
    await this.call('ptz', 'AbsoluteMove', absoluteMoveRequest(profileToken, toVectorInput(vector)));
  }

  async stop(): Promise<void> {
    const profileToken = await this.ptzProfileToken();
    await this.call('ptz', 'Stop', stopRequest(profileToken));
  }

  /** Raw PTZ position, useful to confirm a move landed. */
  async status(): Promise<{ pan?: number; tilt?: number; zoom?: number } | undefined> {
    const profileToken = await this.ptzProfileToken();
    const document = await this.call('ptz', 'GetStatus', getStatusRequest(profileToken));
    const positionNode = findFirst(document, 'Position');
    if (positionNode === undefined) return undefined;
    const panTilt = findFirst(positionNode, 'PanTilt');
    const zoomNode = findFirst(positionNode, 'Zoom');
    return {
      ...(panTilt === undefined ? {} : { pan: number(panTilt.attributes.x), tilt: number(panTilt.attributes.y) }),
      ...(zoomNode === undefined ? {} : { zoom: number(zoomNode.attributes.x) }),
    };
  }

  // -- transport ------------------------------------------------------------

  private async firstProfileToken(): Promise<string> {
    const profiles = await this.mediaProfiles();
    const first = profiles[0];
    if (first === undefined) throw new OnvifError('unsupported', 'The camera reports no media profiles.');
    return first.token;
  }

  /** The profile PTZ must target: configured token, else the first media profile. */
  private async ptzProfileToken(): Promise<string> {
    return this.options.profileToken ?? (await this.firstProfileToken());
  }

  private async call(
    service: 'device' | 'media' | 'ptz',
    operation: string,
    body: string,
  ): Promise<XmlNode> {
    if (service !== 'device' && !this.capabilitiesDone) await this.resolveCapabilities();
    let url: URL;
    try {
      url = new URL(this.urlFor(service));
    } catch {
      throw new OnvifError('protocol', `The camera advertised an unusable ${service} endpoint.`);
    }
    const credentials = this.options.credentials;
    const security =
      credentials?.username === undefined || credentials.password === undefined || this.options.wsSecurity === false
        ? undefined
        : { username: credentials.username, password: credentials.password, created: this.createdAt() };

    // Reuse the last accepted challenge. Cameras rotate nonces, so a stale one
    // still costs a round trip — but it costs one, not two, on the happy path.
    const preemptive = this.basic
      ? this.basicHeader(credentials)
      : this.digest === undefined
        ? undefined
        : this.digestHeader(this.digest, url, credentials);
    const first = await this.post(url, service, operation, soapEnvelope(body, security), preemptive);
    let response = first;
    if (first.status === 401) {
      const challenge = parseDigestChallenge(first.headers.get('www-authenticate'));
      const authorization = challenge !== undefined ? this.digestHeader(challenge, url, credentials) : this.basicHeader(credentials);
      if (authorization === undefined) {
        throw new OnvifError('unauthorized', `The camera rejected the credentials for ${operation}.`);
      }
      if (challenge !== undefined) this.digest = challenge;
      else this.basic = true;
      response = await this.post(url, service, operation, soapEnvelope(body, security), authorization);
      if (response.status === 401) {
        throw new OnvifError('unauthorized', `The camera rejected the credentials for ${operation}.`);
      }
    }

    const text = await response.text();
    if (!response.ok) {
      throw new OnvifError('protocol', `The camera answered ${response.status} to ${operation}.`, {
        detail: soapFaultReason(text) ?? response.statusText,
      });
    }
    const document = parseXml(text);
    if (findFirst(document, 'Fault') !== undefined) {
      throw new OnvifError('soap-fault', soapFaultReason(text) ?? `${operation} failed on the camera.`, {
        detail: operation,
      });
    }
    return document;
  }

  private async post(
    url: URL,
    service: 'device' | 'media' | 'ptz',
    operation: string,
    body: string,
    authorization?: string,
  ): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const action = `${NAMESPACES[service]}/${operation}`;
    const headers: Record<string, string> = {
      'content-type': `application/soap+xml; charset=utf-8; action="${action}"`,
    };
    if (authorization !== undefined) headers.authorization = authorization;
    try {
      return await fetchImpl(url.toString(), {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new OnvifError('timeout', `The camera did not answer ${operation} within ${this.timeoutMs} ms.`);
      }
      throw new OnvifError('unreachable', `Cannot reach ${this.host}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Resolves the media and PTZ service URLs. A device that does not implement
   * GetCapabilities (or answers without XAddrs) gets the conventional paths.
   */
  private async resolveCapabilities(): Promise<void> {
    if (this.capabilitiesDone) return;
    this.capabilitiesDone = true;
    const fallback = deriveServiceUrls(this.endpoint);
    try {
      const document = await this.call('device', 'GetCapabilities', getCapabilitiesRequest());
      const media = textOf(findFirst(document, 'Media'), 'XAddr');
      const ptz = textOf(findFirst(document, 'PTZ'), 'XAddr');
      this.mediaXAddr = media ?? fallback.media;
      this.ptzXAddr = ptz ?? fallback.ptz;
    } catch {
      // Capabilities are optional for our purposes; conventional paths are next.
      this.mediaXAddr = fallback.media;
      this.ptzXAddr = fallback.ptz;
    }
  }

  private urlFor(service: 'device' | 'media' | 'ptz'): string {
    if (service === 'device') return this.endpoint;
    const resolved = service === 'media' ? this.mediaXAddr : this.ptzXAddr;
    return resolved ?? deriveServiceUrls(this.endpoint)[service];
  }

  private digestHeader(challenge: DigestChallenge, url: URL, credentials: Credentials | undefined): string | undefined {
    if (credentials?.username === undefined || credentials.password === undefined) return undefined;
    return digestAuthorization({
      challenge,
      username: credentials.username,
      password: credentials.password,
      method: 'POST',
      uri: `${url.pathname}${url.search}`,
    });
  }

  private basicHeader(credentials: Credentials | undefined): string | undefined {
    if (credentials?.username === undefined || credentials.password === undefined) return undefined;
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
  }

  private createdAt(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }
}

/** `/onvif/device_service` → `/onvif/media_service` and `/onvif/ptz_service`. */
export function deriveServiceUrls(endpoint: string): { media: string; ptz: string } {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return { media: endpoint, ptz: endpoint };
  }
  const directory = base.pathname.replace(/\/[^/]*$/, '');
  const prefix = directory.length === 0 ? '' : directory;
  return {
    media: `${base.origin}${prefix}/media_service`,
    ptz: `${base.origin}${prefix}/ptz_service`,
  };
}

function toVectorInput(vector: Partial<PtzVector>): VectorInput {
  return {
    ...(vector.pan === undefined ? {} : { pan: vector.pan }),
    ...(vector.tilt === undefined ? {} : { tilt: vector.tilt }),
    ...(vector.zoom === undefined ? {} : { zoom: vector.zoom }),
  };
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}


