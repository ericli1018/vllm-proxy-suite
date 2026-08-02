function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContentType(value) {
  const normalized = asString(value).toLowerCase().split(';')[0];
  if (!normalized) return '';
  if (normalized === 'html' || normalized === 'page' || normalized === 'web') return 'text/html';
  if (normalized === 'pdf') return 'application/pdf';
  if (normalized === 'text' || normalized === 'plain') return 'text/plain';
  if (normalized === 'json') return 'application/json';
  if (normalized === 'xml') return 'application/xml';
  return normalized;
}

function canonicalComparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return asString(value);
  }
}

async function readBoundedBuffer(response, maxBytes) {
  const chunks = [];
  let total = 0;
  if (!response.body) {
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > maxBytes) throw new Error(`awesome_web_fetch_response_too_large:${raw.length}`);
    return raw;
  }
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('awesome_web_fetch_response_too_large').catch(() => {});
      throw new Error(`awesome_web_fetch_response_too_large:${total}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason || 'client_cancelled');
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort('awesome_web_fetch_timeout'), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', abortFromParent);
  }
}

export function buildAwesomeWebFetchUrl(config = {}) {
  const base = asString(config.awesomeWebFetchBaseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('awesome_web_fetch_base_url_missing');
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error('awesome_web_fetch_invalid_base_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('awesome_web_fetch_invalid_base_url');
  const path = asString(config.awesomeWebFetchPath) || '/';
  return new URL(path.startsWith('/') ? path : `/${path}`, `${base}/`).toString();
}

export function normalizeAwesomeWebFetchResult(payload, requestedUrl) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  if (list.length === 0) throw new Error('awesome_web_fetch_empty_results');

  const requested = canonicalComparableUrl(requestedUrl);
  let result = list.find((entry) => {
    const metadata = plainObject(entry?.metadata) ? entry.metadata : {};
    const candidates = [metadata.source, metadata.final_url, metadata.finalUrl, metadata.url]
      .map(canonicalComparableUrl)
      .filter(Boolean);
    return candidates.includes(requested);
  });
  if (!result && list.length === 1) result = list[0];
  if (!plainObject(result)) throw new Error('awesome_web_fetch_result_not_found');

  const metadata = plainObject(result.metadata) ? result.metadata : {};
  const error = asString(metadata.error ?? result.error);
  if (error) throw new Error(`awesome_web_fetch_item_error:${error.slice(0, 512)}`);
  const pageContent = asString(result.page_content ?? result.pageContent ?? result.content ?? result.text);
  if (!pageContent) throw new Error('awesome_web_fetch_empty_page_content');

  const finalUrl = asString(metadata.final_url ?? metadata.finalUrl ?? metadata.url ?? metadata.source) || requestedUrl;
  const source = asString(metadata.source) || requestedUrl;
  const title = asString(metadata.title).slice(0, 500);
  const contentType = normalizeContentType(
    metadata.content_type ?? metadata.contentType ?? metadata.mime_type ?? metadata.mimeType ?? metadata.type,
  );
  const statusRaw = metadata.status_code ?? metadata.statusCode ?? metadata.http_status ?? metadata.httpStatus;
  const statusCode = Number.isSafeInteger(Number(statusRaw)) ? Number(statusRaw) : null;
  const browserRenderedRaw = metadata.browser_rendered ?? metadata.browserRendered ?? metadata.rendered;
  const browserRendered = typeof browserRenderedRaw === 'boolean' ? browserRenderedRaw : null;

  return {
    pageContent,
    metadata,
    source,
    finalUrl,
    title,
    contentType,
    statusCode,
    browserRendered,
  };
}

export async function fetchAwesomeWebPage(fetchImpl, input, config = {}, parentSignal) {
  const endpoint = buildAwesomeWebFetchUrl(config);
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
  });
  const apiKey = asString(config.awesomeWebFetchApiKey);
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetchWithTimeout(fetchImpl, endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ urls: [input.url] }),
  }, positiveInteger(config.awesomeWebFetchTimeoutMs, 90000), parentSignal);
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 512);
    throw new Error(`awesome_web_fetch_http_${response.status}${detail ? `:${detail}` : ''}`);
  }
  const raw = await readBoundedBuffer(response, positiveInteger(config.awesomeWebFetchMaxResponseBytes, 8 * 1024 * 1024));
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`awesome_web_fetch_invalid_json:${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeAwesomeWebFetchResult(payload, input.url);
}
