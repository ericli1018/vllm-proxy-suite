import { SseFrameDecoder, encodeSseData } from '../core/sse.js';

const INVISIBLE_PROGRESS_TEXT = '\u200b';

function eventName(frame, payload) {
  return frame.event === 'message' && payload?.type ? payload.type : frame.event;
}

export function createManagedAnthropicStreamStart({ requestId, model }) {
  const messageId = `msg_proxy_${String(requestId || 'managed').replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
    createManagedAnthropicProgressDelta(),
  ].join('');
}

export function createManagedAnthropicProgressDelta() {
  return encodeSseData({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: INVISIBLE_PROGRESS_TEXT },
  }, 'content_block_delta');
}

export function createManagedAnthropicProgressStop() {
  return encodeSseData({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
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
