import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, describe, test } from 'node:test';
import { Notifier, type AlertPayload } from '../src/alerts/notifier.ts';

/**
 * Channel tests run against in-process fake servers on 127.0.0.1, so the real
 * protocol code is exercised rather than a mocked transport. No network access,
 * no credentials, no port assumptions.
 */

const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
});

const PAYLOAD: AlertPayload = {
  ruleId: 'person-alert',
  ruleName: 'Person at the door',
  cameraId: 'front-door',
  cameraName: 'Front door',
  kind: 'ai.object',
  label: 'person',
  confidence: 0.93,
  at: Date.UTC(2026, 0, 1, 12, 0, 0),
  severity: 'warning',
  title: 'Person detected',
  message: 'person detected on Front door',
};

interface SmtpTranscript {
  lines: string[];
  data: string[];
}

/** Speaks just enough SMTP for the client: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
async function fakeSmtp(options: { rejectRecipient?: string } = {}): Promise<{ port: number; transcript: SmtpTranscript }> {
  const transcript: SmtpTranscript = { lines: [], data: [] };
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('220 fake.smtp ESMTP\r\n');

    let buffer = '';
    let inData = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index === -1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 queued\r\n');
          } else {
            transcript.data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }

        transcript.lines.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 accepted\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          if (options.rejectRecipient !== undefined && line.includes(options.rejectRecipient)) {
            socket.write('550 5.1.1 no such user\r\n');
          } else {
            socket.write('250 2.1.5 ok\r\n');
          }
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: address.port, transcript };
}

interface BrokerMessage {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
}

/** Minimal MQTT 3.1.1 broker: CONNECT/CONNACK and PUBLISH with the matching acks. */
async function fakeBroker(): Promise<{
  port: number;
  messages: BrokerMessage[];
  sessions: Array<{ clientId: string; username?: string }>;
}> {
  const messages: BrokerMessage[] = [];
  const sessions: Array<{ clientId: string; username?: string }> = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const header = buffer.readUInt8(0);
        let multiplier = 1;
        let length = 0;
        let index = 1;
        for (;;) {
          if (index >= buffer.length) return;
          const byte = buffer.readUInt8(index);
          length += (byte & 0x7f) * multiplier;
          multiplier *= 128;
          index += 1;
          if ((byte & 0x80) === 0) break;
        }
        if (buffer.length < index + length) return;
        const body = buffer.subarray(index, index + length);
        buffer = buffer.subarray(index + length);
        const type = header >> 4;

        if (type === 1) {
          // Variable header: 2-byte length + "MQTT", level, flags, keepalive.
          let offset = 10;
          const readString = (): string => {
            const size = body.readUInt16BE(offset);
            const value = body.subarray(offset + 2, offset + 2 + size).toString('utf8');
            offset += 2 + size;
            return value;
          };
          const clientId = readString();
          const flags = body.readUInt8(7);
          let username: string | undefined;
          if ((flags & 0x80) !== 0) username = readString();
          sessions.push({ clientId, ...(username === undefined ? {} : { username }) });
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        } else if (type === 3) {
          const qos = (header >> 1) & 0x03;
          const retain = (header & 0x01) === 1;
          const topicLength = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + topicLength).toString('utf8');
          let offset = 2 + topicLength;
          let packetId = 0;
          if (qos > 0) {
            packetId = body.readUInt16BE(offset);
            offset += 2;
          }
          messages.push({ topic, payload: body.subarray(offset).toString('utf8'), qos, retain });
          if (qos === 1) {
            const ack = Buffer.alloc(4);
            ack.writeUInt8(0x40, 0);
            ack.writeUInt8(0x02, 1);
            ack.writeUInt16BE(packetId, 2);
            socket.write(ack);
          } else if (qos === 2) {
            const ack = Buffer.alloc(4);
            ack.writeUInt8(0x50, 0);
            ack.writeUInt8(0x02, 1);
            ack.writeUInt16BE(packetId, 2);
            socket.write(ack);
          }
        } else if (type === 6) {
          // PUBREL → PUBCOMP
          const packetId = body.readUInt16BE(0);
          const ack = Buffer.alloc(4);
          ack.writeUInt8(0x70, 0);
          ack.writeUInt8(0x02, 1);
          ack.writeUInt16BE(packetId, 2);
          socket.write(ack);
        } else if (type === 14) {
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: address.port, messages, sessions };
}

describe('notification channels', () => {
  test('delivers an alert over SMTP with an attached snapshot', async () => {
    const smtp = await fakeSmtp();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const notifier = new Notifier({
      channels: [
        {
          id: 'ops-email',
          name: 'Ops email',
          type: 'email',
          smtp: {
            host: '127.0.0.1',
            port: smtp.port,
            secure: false,
            username: 'nvr',
            password: 'secret',
            from: 'nvr@example.com',
          },
          to: ['ops@example.com'],
          subjectTemplate: '[iCamify] {cameraName}: {label}',
        },
      ],
      dedupeSeconds: 0,
      snapshot: async (relative) =>
        relative === 'front-door/snap.jpg' ? { filename: 'snap.jpg', contentType: 'image/jpeg', content: jpeg } : undefined,
      log: () => {},
    });

    const [result] = await notifier.send({ ...PAYLOAD, snapshot: 'front-door/snap.jpg', attachSnapshot: true }, ['ops-email']);
    assert.equal(result?.ok, true, result?.error);

    const { lines, data } = smtp.transcript;
    assert.ok(lines.some((line) => line === 'MAIL FROM:<nvr@example.com>'), lines.join('\n'));
    assert.ok(lines.some((line) => line === 'RCPT TO:<ops@example.com>'));

    const auth = lines.find((line) => line.startsWith('AUTH PLAIN '));
    assert.ok(auth !== undefined, 'expected AUTH PLAIN');
    assert.equal(Buffer.from(auth.split(' ')[2] ?? '', 'base64').toString('utf8'), '\0nvr\0secret');

    const body = data.join('\r\n');
    assert.match(body, /Subject: \[iCamify\] Front door: person/);
    assert.match(body, /Content-Type: multipart\/mixed/);
    assert.match(body, /filename="snap.jpg"/);
    assert.match(body, /Content-Type: multipart\/alternative/);
    assert.ok(body.includes(jpeg.toString('base64')), 'the snapshot bytes should be attached');
  });

  test('reports a rejected SMTP recipient as a failed delivery', async () => {
    const smtp = await fakeSmtp({ rejectRecipient: 'blocked@' });
    const notifier = new Notifier({
      channels: [
        {
          id: 'mail',
          name: 'Mail',
          type: 'email',
          smtp: { host: '127.0.0.1', port: smtp.port, secure: false, from: 'nvr@example.com' },
          to: ['blocked@example.com'],
        },
      ],
      dedupeSeconds: 0,
      log: () => {},
    });

    const [result] = await notifier.send(PAYLOAD, ['mail']);
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /550/);
  });

  test('publishes an alert to MQTT, with Home Assistant discovery first', async () => {
    const broker = await fakeBroker();
    const notifier = new Notifier({
      channels: [
        {
          id: 'mqtt-events',
          name: 'MQTT events',
          type: 'mqtt',
          url: `mqtt://127.0.0.1:${broker.port}`,
          topic: 'icamify/events',
          qos: 1,
          retain: false,
          username: 'nvr',
          password: 'secret',
          homeAssistantDiscovery: true,
        },
      ],
      dedupeSeconds: 0,
      log: () => {},
    });

    const [result] = await notifier.send(PAYLOAD, ['mqtt-events']);
    assert.equal(result?.ok, true, result?.error);
    assert.equal(broker.sessions[0]?.username, 'nvr');

    const discovery = broker.messages[0];
    assert.equal(discovery?.retain, true);
    assert.match(discovery?.topic ?? '', /^homeassistant\/sensor\/icamify_mqtt-events\/config$/);
    const document = JSON.parse(discovery?.payload ?? '{}') as { state_topic?: string };
    assert.equal(document.state_topic, 'icamify/events');

    const event = broker.messages[1];
    assert.equal(event?.topic, 'icamify/events');
    assert.equal(event?.qos, 1);
    assert.equal(event?.retain, false);
    const envelope = JSON.parse(event?.payload ?? '{}') as { type: string; camera: { name: string } };
    assert.equal(envelope.type, 'icamify.alert');
    assert.equal(envelope.camera.name, 'Front door');
  });

  test('escapes Telegram HTML and sends a snapshot as a photo', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const notifier = new Notifier({
      channels: [{ id: 'tg', name: 'Telegram', type: 'telegram', botToken: '123:abc', chatId: '42', parseMode: 'HTML' }],
      dedupeSeconds: 0,
      fetch: (async (input: string | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      snapshot: async () => ({ filename: 'snap.jpg', contentType: 'image/jpeg', content: Buffer.from([1, 2, 3]) }),
      log: () => {},
    });

    const [plain] = await notifier.send({ ...PAYLOAD, message: 'person <script> at Front door' }, ['tg']);
    assert.equal(plain?.ok, true, plain?.error);
    assert.match(requests[0]?.url ?? '', /\/bot123:abc\/sendMessage$/);
    const body = JSON.parse(String(requests[0]?.init?.body)) as { chat_id: string; text: string; parse_mode: string };
    assert.equal(body.chat_id, '42');
    assert.equal(body.parse_mode, 'HTML');
    assert.ok(body.text.includes('&lt;script&gt;'), 'HTML must be escaped');

    const [photo] = await notifier.send({ ...PAYLOAD, snapshot: 'front/snap.jpg', attachSnapshot: true }, ['tg']);
    assert.equal(photo?.ok, true, photo?.error);
    assert.match(requests[1]?.url ?? '', /\/sendPhoto$/);
    const form = requests[1]?.init?.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('chat_id'), '42');
    assert.match(String(form.get('caption')), /Person detected/);
    assert.ok(form.get('photo') instanceof Blob);
  });

  test('reports a channel that cannot be reached instead of throwing', async () => {
    const notifier = new Notifier({
      channels: [{ id: 'mqtt-down', name: 'MQTT down', type: 'mqtt', url: 'mqtt://127.0.0.1:1', topic: 'x' }],
      dedupeSeconds: 0,
      timeoutMs: 500,
      log: () => {},
    });
    const [result] = await notifier.send(PAYLOAD, ['mqtt-down']);
    assert.equal(result?.ok, false);
    assert.ok((result?.error ?? '').length > 0);
  });
});
