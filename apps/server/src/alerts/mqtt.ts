import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * Minimal MQTT 3.1.1 publisher.
 *
 * Publishing an alert is a short-lived connection with no subscriptions, so a
 * full client library (reconnect loops, persistence, session state) would be
 * dead weight. This implements exactly CONNECT, CONNACK, PUBLISH at QoS 0/1/2,
 * the handshakes those require, and DISCONNECT.
 */

export type MqttSocket = Socket | TLSSocket;

export interface MqttPublish {
  topic: string;
  payload: string | Buffer;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export interface MqttOptions {
  /** mqtt:// or mqtts:// (WebSocket transports are not supported). */
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepAliveSeconds?: number;
  timeoutMs?: number;
}

export class MqttError extends Error {
  readonly stage: string;
  /** CONNACK return code when the broker refused the session. */
  readonly returnCode?: number;

  constructor(message: string, stage: string, returnCode?: number) {
    super(message);
    this.name = 'MqttError';
    this.stage = stage;
    if (returnCode !== undefined) this.returnCode = returnCode;
  }
}

interface MqttPacket {
  type: number;
  flags: number;
  body: Buffer;
}

function encodeLength(length: number): Buffer {
  const bytes: number[] = [];
  let remaining = length;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function encodeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function encodeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

function packet(header: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([header]), encodeLength(body.length), body]);
}

function connectPacket(options: {
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSeconds: number;
}): Buffer {
  const flags =
    0x02 | // clean session
    (options.username === undefined ? 0 : 0x80) |
    (options.password === undefined ? 0 : 0x40);
  const variable = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([4, flags]),
    encodeUInt16(options.keepAliveSeconds),
  ]);
  const payload = [encodeString(options.clientId)];
  if (options.username !== undefined) payload.push(encodeString(options.username));
  if (options.password !== undefined) payload.push(encodeString(options.password));
  return packet(0x10, Buffer.concat([variable, ...payload]));
}

function publishPacket(message: MqttPublish, packetId: number): Buffer {
  const qos = message.qos ?? 0;
  const header = 0x30 | (qos << 1) | (message.retain === true ? 1 : 0);
  const payload = Buffer.isBuffer(message.payload) ? message.payload : Buffer.from(message.payload, 'utf8');
  const variable: Buffer[] = [encodeString(message.topic)];
  if (qos > 0) variable.push(encodeUInt16(packetId));
  return packet(header, Buffer.concat([...variable, payload]));
}

/** Splits a byte stream into MQTT control packets. */
class PacketReader {
  private buffer = Buffer.alloc(0);
  private readonly queue: MqttPacket[] = [];
  private waiter: { resolve: (packet: MqttPacket) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  private failure: Error | undefined;
  private readonly socket: MqttSocket;

  constructor(socket: MqttSocket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  async next(timeoutMs: number, stage: string): Promise<MqttPacket> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.failure !== undefined) throw this.failure;
    return await new Promise<MqttPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new MqttError(`timed out after ${timeoutMs}ms waiting for the broker (${stage})`, stage));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const parsed = this.parse();
      if (parsed === undefined) return;
      this.deliver(parsed.packet);
      this.buffer = this.buffer.subarray(parsed.consumed);
    }
  };

  private parse(): { packet: MqttPacket; consumed: number } | undefined {
    if (this.buffer.length < 2) return undefined;
    const header = this.buffer.readUInt8(0);
    let multiplier = 1;
    let length = 0;
    let index = 1;
    for (;;) {
      if (index >= this.buffer.length) return undefined;
      const byte = this.buffer.readUInt8(index);
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      index += 1;
      if ((byte & 0x80) === 0) break;
      if (index > 4) throw new MqttError('malformed remaining-length field', 'decode');
    }
    if (this.buffer.length < index + length) return undefined;
    return {
      packet: {
        type: header >> 4,
        flags: header & 0x0f,
        body: this.buffer.subarray(index, index + length),
      },
      consumed: index + length,
    };
  }

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private readonly onClose = (): void => {
    this.fail(new MqttError('the broker closed the connection', 'closed'));
  };

  private fail(error: Error): void {
    this.failure = error;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private deliver(packet: MqttPacket): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
      return;
    }
    this.queue.push(packet);
  }
}

function write(socket: MqttSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error === undefined || error === null ? resolve() : reject(error)));
  });
}

async function openSocket(host: string, port: number, secure: boolean, timeoutMs: number): Promise<MqttSocket> {
  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MqttError(`timed out connecting to the broker at ${host}:${port}`, 'connect'));
    }, timeoutMs);
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    if (secure) socket.once('secureConnect', () => settle());
    else socket.once('connect', () => settle());
    socket.once('error', (error) => settle(error));
    socket.once('close', () => settle(new MqttError(`the broker closed ${host}:${port} during setup`, 'connect')));
  });
  socket.setNoDelay(true);
  return socket;
}

async function waitFor(
  reader: PacketReader,
  type: number,
  packetId: number | undefined,
  timeoutMs: number,
  stage: string,
): Promise<MqttPacket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MqttError(`timed out waiting for the broker's reply (${stage})`, stage);
    const incoming = await reader.next(remaining, stage);
    if (incoming.type !== type) continue;
    if (packetId === undefined) return incoming;
    const incomingId = incoming.body.length >= 2 ? incoming.body.readUInt16BE(0) : -1;
    if (incomingId === packetId) return incoming;
  }
}

/**
 * Publishes every message on one connection, in order, then disconnects.
 *
 * QoS 1 waits for PUBACK and QoS 2 runs the full PUBREC/PUBREL/PUBCOMP exchange,
 * so a resolved promise means the broker accepted the message, not merely that
 * the bytes left the process.
 */
export async function publishMqtt(options: MqttOptions, messages: ReadonlyArray<MqttPublish>): Promise<void> {
  if (messages.length === 0) return;
  const url = new URL(options.url);
  const secure = url.protocol === 'mqtts:';
  if (url.protocol !== 'mqtt:' && !secure) {
    throw new MqttError(`unsupported MQTT transport "${url.protocol}"; use mqtt:// or mqtts://`, 'url');
  }
  const host = url.hostname;
  const port = url.port.length > 0 ? Number(url.port) : secure ? 8883 : 1883;
  const timeoutMs = options.timeoutMs ?? 8000;

  let socket = await openSocket(host, port, secure, timeoutMs);
  const reader = new PacketReader(socket);

  try {
    await write(
      socket,
      connectPacket({
        clientId: options.clientId ?? `icamify-${Math.random().toString(16).slice(2, 10)}`,
        keepAliveSeconds: options.keepAliveSeconds ?? 30,
        ...(options.username === undefined ? {} : { username: options.username }),
        ...(options.password === undefined ? {} : { password: options.password }),
      }),
    );
    const connack = await waitFor(reader, 2, undefined, timeoutMs, 'connack');
    const returnCode = connack.body.length >= 2 ? connack.body.readUInt8(1) : 255;
    if (returnCode !== 0) {
      throw new MqttError(`the broker refused the connection (CONNACK ${returnCode})`, 'connack', returnCode);
    }

    let packetId = 1;
    for (const message of messages) {
      const qos = message.qos ?? 0;
      const id = qos > 0 ? (packetId = packetId >= 0xffff ? 1 : packetId + 1) : 0;
      await write(socket, publishPacket(message, id));
      if (qos === 1) {
        await waitFor(reader, 4, id, timeoutMs, 'puback');
      } else if (qos === 2) {
        await waitFor(reader, 5, id, timeoutMs, 'pubrec');
        await write(socket, packet(0x62, encodeUInt16(id)));
        await waitFor(reader, 7, id, timeoutMs, 'pubcomp');
      }
    }

    await write(socket, packet(0xe0, Buffer.alloc(0)));
  } finally {
    reader.detach();
    socket.destroy();
  }
}
