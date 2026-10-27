import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { DiscoveredDevice, DiscoveryOptions } from './index.ts';
import { findAll, parseXml, textOf } from './xml.ts';

/**
 * WS-Discovery for ONVIF cameras.
 *
 * A `Probe` for `dn:NetworkVideoTransmitter` is sent to the WS-Discovery multicast
 * group, then every `ProbeMatches` response is collected for `timeoutMs`. The probe
 * is retransmitted once, because UDP multicast is lossy by design and a camera
 * that misses the first datagram will never be discovered.
 *
 * No subnet sweep is attempted: scanning 254 addresses per subnet with SOAP is
 * slower, noisier and gets firewalled more often than multicast, and a camera that
 * does not answer discovery is better added by host in the configuration.
 */

export interface DiscoveryTransport {
  send(message: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(): void;
  onMessage(listener: (message: Buffer) => void): void;
  onError(listener: (error: Error) => void): void;
  /** Resolves once the socket is bound and able to send. */
  ready?(): Promise<void>;
}

export type DiscoveryTransportFactory = () => DiscoveryTransport;

export const DEFAULT_MULTICAST_ADDRESS = '239.255.255.250';
export const DEFAULT_MULTICAST_PORT = 3702;

/** SOAP Probe for a network video transmitter, the ONVIF device class. */
export function buildProbeMessage(messageId = `uuid:${randomUUID()}`): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
    `xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
    `<e:Header><w:MessageID>${messageId}</w:MessageID>` +
    `<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    `<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>` +
    `<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`
  );
}

export interface OnvifScopes {
  name?: string;
  hardware?: string;
  location?: string;
  profile?: string;
  /** Raw `onvif://www.onvif.org/type/...` entries. */
  types: string[];
}

/**
 * Scopes are `onvif://www.onvif.org/name/Front%20Door` style URIs. Only the four
 * that mean something to an operator are kept; the rest stays in `types`.
 */
export function parseScopes(scopes: string[]): OnvifScopes {
  const result: OnvifScopes = { types: [] };
  for (const scope of scopes) {
    const match = /^onvif:\/\/www\.onvif\.org\/(name|hardware|location)\/(.+)$/.exec(scope);
    if (match !== null) {
      const key = match[1] as 'name' | 'hardware' | 'location';
      result[key] = safeDecode(match[2] as string);
      continue;
    }
    const type = /^onvif:\/\/www\.onvif\.org\/type\/(.+)$/.exec(scope);
    if (type !== null) result.types.push(safeDecode(type[1] as string));
  }
  return result;
}

/** Parses a `ProbeMatches` body. Unknown or malformed matches are skipped. */
export function parseProbeMatches(xml: string, now = Date.now()): DiscoveredDevice[] {
  const document = parseXml(xml);
  const devices: DiscoveredDevice[] = [];
  for (const match of findAll(document, 'ProbeMatch')) {
    const urn = textOf(match, 'Address');
    const xaddr = (textOf(match, 'XAddrs') ?? '').split(/\s+/).filter(Boolean)[0];
    if (urn === undefined || xaddr === undefined) continue;
    let host = xaddr;
    let port: number | undefined;
    try {
      const url = new URL(xaddr);
      host = url.hostname;
      port = url.port.length === 0 ? undefined : Number(url.port);
    } catch {
      // A device that advertises a non-URL XAddr is still worth listing.
    }
    const scopes = (textOf(match, 'Scopes') ?? '').split(/\s+/).filter(Boolean);
    const parsed = parseScopes(scopes);
    devices.push({
      urn,
      xaddr,
      host,
      ...(port === undefined ? {} : { port }),
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.hardware === undefined ? {} : { hardware: parsed.hardware }),
      ...(parsed.location === undefined ? {} : { location: parsed.location }),
      scopes,
      discoveredAt: now,
    });
  }
  return devices;
}

export interface DiscoveryRunOptions extends DiscoveryOptions {
  createTransport?: DiscoveryTransportFactory;
  now?: () => number;
  /** Reports socket problems without failing the scan (multicast is often blocked). */
  onWarning?: (message: string) => void;
}

/** One discovery scan. Resolves with every device that answered within the timeout. */
export async function discoverDevices(options: DiscoveryRunOptions = {}): Promise<DiscoveredDevice[]> {
  const address = options.multicastAddress ?? DEFAULT_MULTICAST_ADDRESS;
  const port = options.multicastPort ?? DEFAULT_MULTICAST_PORT;
  const timeoutMs = Math.max(250, options.timeoutMs ?? 3000);
  const now = options.now ?? Date.now;
  const transport = (options.createTransport ?? datagramTransport)();
  const found = new Map<string, DiscoveredDevice>();

  transport.onMessage((message) => {
    let text: string;
    try {
      text = message.toString('utf8');
    } catch {
      return;
    }
    for (const device of parseProbeMatches(text, now())) {
      const existing = found.get(device.urn);
      if (existing === undefined) {
        found.set(device.urn, device);
      } else if (existing.name === undefined && device.name !== undefined) {
        found.set(device.urn, device);
      }
    }
  });
  transport.onError((error) => options.onWarning?.(`discovery socket: ${error.message}`));

  try {
    await transport.ready?.();
    const probe = Buffer.from(buildProbeMessage());
    transport.send(probe, port, address, (error) => {
      if (error !== null) options.onWarning?.(`discovery probe failed: ${error.message}`);
    });
    // A second probe after 400 ms: one lost datagram should not hide a camera.
    await delay(Math.min(400, Math.floor(timeoutMs / 3)));
    transport.send(probe, port, address, (error) => {
      if (error !== null) options.onWarning?.(`discovery probe failed: ${error.message}`);
    });
    await delay(Math.max(0, timeoutMs - Math.min(400, Math.floor(timeoutMs / 3))));
  } finally {
    transport.close();
  }

  return [...found.values()].sort(
    (left, right) => (left.name ?? left.host).localeCompare(right.name ?? right.host),
  );
}

/** UDP multicast sender. `ready()` resolves after `bind`, which sending requires. */
export function datagramTransport(): DiscoveryTransport {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  let bound: Promise<void>;
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.off('error', reject);
      try {
        socket.setMulticastTTL(2);
        socket.setBroadcast(true);
      } catch {
        // Not fatal: some container networks refuse these options.
      }
      resolve();
    });
  });
  bound = ready;
  socket.on('error', () => undefined);

  return {
    ready: () => bound,
    send: (message, port, address, callback) => {
      try {
        socket.send(message, port, address, (error) => callback?.(error ?? null));
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
    onMessage: (listener) => {
      socket.on('message', (message) => listener(message));
    },
    onError: (listener) => {
      socket.on('error', (error) => listener(error));
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
