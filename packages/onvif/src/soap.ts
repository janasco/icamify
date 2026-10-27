import { createHash, randomBytes } from 'node:crypto';
import { escapeXml, parseXml, textOf } from './xml.ts';

/**
 * SOAP 1.2 envelopes for the ONVIF operations iCamify needs.
 *
 * Operations are built as strings rather than from WSDL-generated classes: there
 * are eleven of them, the shapes are stable since Profile S, and a generator would
 * add a build step and a large dependency to a single-process appliance.
 *
 * Authentication is belt and braces, because camera firmware disagrees:
 * - a WS-Security `UsernameToken` with a digest password is sent when credentials
 *   are configured (accepted by most devices);
 * - an HTTP `Digest` challenge is answered as well, because others only check the
 *   transport.
 */

export const NAMESPACES = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
} as const;

export const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
export const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
export const PASSWORD_TEXT = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

export interface WsSecurityOptions {
  username: string;
  password: string;
  /** Base64 nonce; random per request in production. */
  nonce?: string;
  /** ISO timestamp inside the token. */
  created?: string;
  /** Use PasswordText instead of the SHA-1 digest (defaults to digest). */
  plainPassword?: boolean;
}

/** `Base64(SHA1(nonce + created + password))`, as the UsernameToken profile requires. */
export function passwordDigest(nonce: string, created: string, password: string): string {
  return createHash('sha1').update(nonce + created + password, 'utf8').digest('base64');
}

export function soapEnvelope(body: string, security?: WsSecurityOptions): string {
  const header = security === undefined ? '' : `<s:Header>${wsSecurityHeader(security)}</s:Header>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NAMESPACES.soap}" xmlns:tds="${NAMESPACES.device}" ` +
    `xmlns:trt="${NAMESPACES.media}" xmlns:tptz="${NAMESPACES.ptz}" xmlns:tt="${NAMESPACES.schema}">` +
    `${header}<s:Body>${body}</s:Body></s:Envelope>`
  );
}

export function wsSecurityHeader(options: WsSecurityOptions): string {
  const nonce = options.nonce ?? randomBytes(16).toString('base64');
  const created = options.created ?? new Date().toISOString();
  const password = options.plainPassword === true ? options.password : passwordDigest(nonce, created, options.password);
  const type = options.plainPassword === true ? PASSWORD_TEXT : PASSWORD_DIGEST;
  return (
    `<wsse:Security xmlns:wsse="${NAMESPACES.wsse}" xmlns:wsu="${NAMESPACES.wsu}">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(options.username)}</wsse:Username>` +
    `<wsse:Password Type="${type}">${escapeXml(password)}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${BASE64_BINARY}">${escapeXml(nonce)}</wsse:Nonce>` +
    `<wsu:Created>${escapeXml(created)}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

export function getCapabilitiesRequest(): string {
  return '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>';
}

export function deviceInformationRequest(): string {
  return '<tds:GetDeviceInformation/>';
}

export function getProfilesRequest(): string {
  return '<trt:GetProfiles/>';
}

export function getStreamUriRequest(profileToken: string): string {
  return (
    `<trt:GetStreamUri><trt:StreamSetup>` +
    `<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>` +
    `</trt:StreamSetup><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`
  );
}

export function getSnapshotUriRequest(profileToken: string): string {
  return `<trt:GetSnapshotUri><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetSnapshotUri>`;
}

export interface VectorInput {
  pan?: number;
  tilt?: number;
  zoom?: number;
}

/** ISO 8601 duration for a `PTZ/Timeout`, rounded up to whole seconds. */
export function isoDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return `PT${seconds}S`;
}

function velocity(vector: VectorInput): string {
  const pan = clamp(vector.pan ?? 0, -1, 1);
  const tilt = clamp(vector.tilt ?? 0, -1, 1);
  const zoom = clamp(vector.zoom ?? 0, -1, 1);
  return `<tptz:Velocity><tt:PanTilt x="${pan}" y="${tilt}"/><tt:Zoom x="${zoom}"/></tptz:Velocity>`;
}

function position(vector: VectorInput): string {
  return (
    `<tptz:Position><tt:PanTilt x="${clamp(vector.pan ?? 0, -1, 1)}" y="${clamp(vector.tilt ?? 0, -1, 1)}"/>` +
    `<tt:Zoom x="${clamp(vector.zoom ?? 0, -1, 1)}"/></tptz:Position>`
  );
}

export function continuousMoveRequest(profileToken: string, vector: VectorInput, durationMs: number): string {
  return (
    `<tptz:ContinuousMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>` +
    `${velocity(vector)}<tptz:Timeout>${isoDuration(durationMs)}</tptz:Timeout></tptz:ContinuousMove>`
  );
}

export function absoluteMoveRequest(profileToken: string, vector: VectorInput): string {
  return (
    `<tptz:AbsoluteMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>` +
    `${position(vector)}</tptz:AbsoluteMove>`
  );
}

export function stopRequest(profileToken: string): string {
  return (
    `<tptz:Stop><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>` +
    `<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`
  );
}

export function getPresetsRequest(profileToken: string): string {
  return `<tptz:GetPresets><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetPresets>`;
}

export function gotoPresetRequest(profileToken: string, presetToken: string): string {
  return (
    `<tptz:GotoPreset><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>` +
    `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken></tptz:GotoPreset>`
  );
}

export function getStatusRequest(profileToken: string): string {
  return `<tptz:GetStatus><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetStatus>`;
}

/** Reason string from a SOAP Fault, which is what a camera says went wrong. */
export function soapFaultReason(xml: string): string | undefined {
  const document = parseXml(xml);
  const fault = textOf(document, 'Text') ?? textOf(document, 'Reason');
  return fault === undefined || fault.length === 0 ? undefined : fault;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(min, Math.min(max, value)) * 1000) / 1000;
}
