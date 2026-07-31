import { SseFrameDecoder, encodeSseData } from '../core/sse.js';

export const MANAGED_PROGRESS_SENTINEL = '\u2063';
const INVISIBLE_PROGRESS_TEXT = '\u200b';
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f]+/g;

function eventName(frame, payload) {
  return frame.event === 'message' && payload?.type ? payload.type : frame.event;
}

function boundedInteger(value, fallback, min = 0, max = 10000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function progressMode(config = {}) {
  const value = String(config.mode || 'visible').toLowerCase();
  return ['visible', 'minimal', 'invisible', 'off'].includes(value) ? value : 'visible';
}

function progressDetail(config = {}) {
  return String(config.detail || 'query').toLowerCase() === 'tool' ? 'tool' : 'query';
}

export function sanitizeManagedProgressLabel(value, maxChars = 160) {
  const limit = boundedInteger(maxChars, 160, 16, 1000);
  return String(value ?? '')
    .replace(CONTROL_OR_LINE_BREAK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safeHostname(value) {
  try {
    const url = new URL(String(value || ''));
    return sanitizeManagedProgressLabel(url.hostname, 253);
  } catch {
    return sanitizeManagedProgressLabel(value, 253).split(/[/?#]/, 1)[0];
  }
}

function actionLabel(kind) {
  return kind === 'fetch' ? '正在讀取' : '正在搜尋';
}

function startedText(event = {}, config = {}) {
  const mode = progressMode(config);
  if (mode === 'invisible') return INVISIBLE_PROGRESS_TEXT;
  if (mode === 'off') return '';
  const action = actionLabel(event.kind);
  if (mode === 'minimal' || progressDetail(config) === 'tool') return `${action}…`;
  const raw = event.kind === 'fetch' ? safeHostname(event.displayValue) : sanitizeManagedProgressLabel(event.displayValue, config.maxLabelChars);
  return raw ? `${action}：${raw}` : `${action}…`;
}

function completedText(event = {}) {
  if (event.kind === 'fetch') {
    if (event.ok === false) return '\n讀取失敗。';
    if (Number.isInteger(event.chunks) && event.chunks > 0) return `\n讀取完成，共分析 ${event.chunks} 個區段。`;
    return '\n讀取完成。';
  }
  if (event.ok === false) return '\n搜尋失敗。';
  if (Number.isInteger(event.resultCount)) return `\n搜尋完成，取得 ${event.resultCount} 筆結果。`;
  return '\n搜尋完成。';
}

function delta(text) {
  return encodeSseData({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }, 'content_block_delta');
}

export function createManagedAnthropicStreamStart({ requestId, model, event = {}, progressConfig = {} }) {
  const messageId = `msg_proxy_${String(requestId || 'managed').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const initial = startedText(event, progressConfig) || INVISIBLE_PROGRESS_TEXT;
  return [
    encodeSseData({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: String(model || 'managed-web-tools'),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }, 'message_start'),
    encodeSseData({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }, 'content_block_start'),
    delta(`${MANAGED_PROGRESS_SENTINEL}${initial}`),
  ].join('');
}

export function createManagedAnthropicProgressDelta({ mode = 'visible', dotCount = 0, maxDots = 12 } = {}) {
  const normalizedMode = progressMode({ mode });
  const boundedMaxDots = boundedInteger(maxDots, 12, 0, 100);
  const visibleMode = normalizedMode === 'visible' || normalizedMode === 'minimal';
  const text = visibleMode && boundedMaxDots > 0
    ? (dotCount > 0 && dotCount % boundedMaxDots === 0 ? '\n…' : '…')
    : INVISIBLE_PROGRESS_TEXT;
  return delta(text);
}

export function createManagedAnthropicStatusDelta(event = {}, config = {}) {
  const mode = progressMode(config);
  let text;
  if (mode === 'invisible') text = INVISIBLE_PROGRESS_TEXT;
  else if (event.phase === 'completed') text = completedText(event);
  else text = `\n${startedText(event, config) || INVISIBLE_PROGRESS_TEXT}`;
  return delta(text);
}

export function createManagedAnthropicProgressStop() {
  return encodeSseData({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
}

export function stripManagedProgressBlocks(messages) {
  if (!Array.isArray(messages)) return messages;
  const output = [];
  for (const message of messages) {
    const cloned = structuredClone(message);
    if (Array.isArray(cloned?.content)) {
      cloned.content = cloned.content.filter((block) => !(
        block?.type === 'text'
        && typeof block.text === 'string'
        && block.text.startsWith(MANAGED_PROGRESS_SENTINEL)
      ));
      if (cloned.content.length === 0 && cloned.role === 'assistant') continue;
    } else if (typeof cloned?.content === 'string' && cloned.content.startsWith(MANAGED_PROGRESS_SENTINEL)) {
      continue;
    }
    output.push(cloned);
  }
  return output;
}

export function spliceManagedAnthropicStream(rawBody) {
  const decoder = new SseFrameDecoder();
  const frames = [...decoder.push(rawBody), ...decoder.finish()];
  const output = [createManagedAnthropicProgressStop()];

  for (const frame of frames) {
    if (frame.incomplete) throw new Error('managed_stream_incomplete_sse_frame');
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      throw new Error('managed_stream_invalid_sse_json');
    }
    const event = eventName(frame, payload);
    if (event === 'message_start') continue;
    if (event === 'content_block_start' || event === 'content_block_delta' || event === 'content_block_stop') {
      if (!Number.isInteger(payload?.index)) throw new Error('managed_stream_invalid_content_index');
      payload = { ...payload, index: payload.index + 1 };
    }
    output.push(encodeSseData(payload, event));
  }

  return Buffer.from(output.join(''), 'utf8');
}
