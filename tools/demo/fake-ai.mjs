#!/usr/bin/env node
/**
 * DeepStack / CodeProject.AI shaped detector, for the demo.
 *
 * The gateway in `@icamify/ai` posts a JPEG and expects `{ success, predictions }`.
 * This stub returns a person and a car with plausible boxes, so the alert pipeline,
 * the AI labels on the tile and the object filters on a rule can all be exercised
 * without a GPU or a real model.
 *
 * It alternates the number of detections, which is what makes the per-label rule
 * behaviour visible: one frame says "person", the next says "person + car".
 *
 * `node tools/demo/fake-ai.mjs --port 8765`
 */
import { createServer } from 'node:http';

const options = parseArgs(process.argv.slice(2));
const port = Number(options.port ?? 8765);
const host = '127.0.0.1';
let calls = 0;

const server = createServer((request, response) => {
  const started = Date.now();
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && (url === '/health' || url === '/v1/vision/detection/process')) {
      json(response, 200, { success: true, status: 'ready' });
      return;
    }
    if (request.method !== 'POST') {
      json(response, 405, { success: false, error: 'only POST is supported' });
      return;
    }

    calls += 1;
    const bytes = Buffer.concat(chunks).length;
    if (bytes === 0) {
      json(response, 400, { success: false, error: 'no image was posted' });
      return;
    }

    const withCar = calls % 2 === 1;
    const predictions = [
      { label: 'person', confidence: 0.91, ...box(0.18, 0.24, 0.16, 0.52) },
      ...(withCar ? [{ label: 'car', confidence: 0.78, ...box(0.55, 0.42, 0.3, 0.28) }] : []),
    ];
    process.stdout.write(
      `[ai] ${url} ${bytes}B → ${predictions.map((prediction) => `${prediction.label} ${prediction.confidence}`).join(', ')} (${Date.now() - started}ms)\n`,
    );
    // DeepStack returns normalised 0..1 coordinates in x_min/x_max/y_min/y_max.
    json(response, 200, { success: true, predictions });
  });
});

server.listen(port, host, () => {
  process.stdout.write(`[ai] DeepStack-compatible stub on http://${host}:${port}/v1/vision/detection\n`);
});

function box(x, y, width, height) {
  return { x_min: x, y_min: y, x_max: x + width, y_max: y + height };
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) continue;
    result[flag.slice(2)] = next;
    index += 1;
  }
  return result;
}
