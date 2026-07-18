import { once } from 'node:events';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'content-encoding',
]);

export async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('request body exceeds configured limit');
      error.code = 'request_body_limit';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function buildUpstreamHeaders(request, config, requestId) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'authorization' || lower === 'x-api-key') continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${config.vllmApiKey}`);
  headers.set('x-request-id', requestId);
  return headers;
}

export function copyResponseHeaders(source, { bodyLength = null } = {}) {
  const headers = {};
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    headers[name] = value;
  });
  if (bodyLength !== null) headers['content-length'] = String(bodyLength);
  return headers;
}

export async function writeNodeResponseBody(response, body) {
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(Buffer.from(value))) await once(response, 'drain');
  }
}

export function jsonResponse(response, status, payload, extraHeaders = {}) {
  if (response.headersSent) return false;
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
  return true;
}
