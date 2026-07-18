import { SseFrameDecoder } from '../core/sse.js';

const UNSUPPORTED_FIELDS = [
  'thinking_token_budget',
  'repetition_detection',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'min_p',
  'max_new_tokens',
  'reasoning_budget',
  'reasoning_effort',
  'seed',
];

function invalid(reason, detail = reason) {
  return { ok: false, reason, detail };
}

function isNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isInteger(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function createBlock(index, content = {}) {
  return {
    index,
    type: content.type || 'unknown',
    id: content.id || null,
    name: content.name || null,
    thinking: typeof content.thinking === 'string' ? content.thinking : '',
    signature: null,
    text: typeof content.text === 'string' ? content.text : '',
    partialJson: '',
    input: content.input && typeof content.input === 'object' && !Array.isArray(content.input) ? structuredClone(content.input) : null,
    toolJsonError: null,
    stopped: false,
    rawDeltas: [],
  };
}

class AnthropicMessagesStreamParser {
  constructor() {
    this.decoder = new SseFrameDecoder();
    this.messageStart = null;
    this.messageDelta = null;
    this.messageStopped = false;
    this.stopReason = null;
    this.stopSequence = null;
    this.blocks = [];
    this.blocksByIndex = new Map();
    this.error = null;
    this.structuralErrors = [];
    this.eventCount = 0;
    this.reasoningBytes = 0;
    this.contentBytes = 0;
    this.toolNameBytes = 0;
    this.toolArgumentBytes = 0;
  }

  push(chunk) {
    for (const frame of this.decoder.push(chunk)) this.#handleFrame(frame);
  }

  #handleFrame(frame) {
    if (frame.incomplete) {
      this.structuralErrors.push('incomplete_sse_frame');
      return;
    }
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      this.structuralErrors.push('invalid_sse_json');
      return;
    }
    this.eventCount += 1;
    const event = frame.event === 'message' && payload?.type ? payload.type : frame.event;
    switch (event) {
      case 'message_start':
        if (this.messageStart) this.structuralErrors.push('duplicate_message_start');
        else this.messageStart = structuredClone(payload);
        break;
      case 'ping':
        break;
      case 'content_block_start': {
        const index = payload?.index;
        if (!Number.isInteger(index) || this.blocksByIndex.has(index)) {
          this.structuralErrors.push('invalid_content_block_start');
          break;
        }
        const block = createBlock(index, payload.content_block || {});
        this.reasoningBytes += Buffer.byteLength(block.thinking || '', 'utf8');
        this.contentBytes += Buffer.byteLength(block.text || '', 'utf8');
        if (block.type === 'tool_use') {
          this.toolNameBytes += Buffer.byteLength(block.name || '', 'utf8');
          if (block.input) this.toolArgumentBytes += Buffer.byteLength(JSON.stringify(block.input), 'utf8');
        }
        this.blocks.push(block);
        this.blocksByIndex.set(index, block);
        break;
      }
      case 'content_block_delta': {
        const block = this.blocksByIndex.get(payload?.index);
        if (!block || block.stopped) {
          this.structuralErrors.push('orphan_content_block_delta');
          break;
        }
        const delta = payload?.delta || {};
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking += delta.thinking;
          this.reasoningBytes += Buffer.byteLength(delta.thinking, 'utf8');
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = delta.signature;
        else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text += delta.text;
          this.contentBytes += Buffer.byteLength(delta.text, 'utf8');
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.partialJson += delta.partial_json;
          this.toolArgumentBytes += Buffer.byteLength(delta.partial_json, 'utf8');
        } else block.rawDeltas.push(structuredClone(payload));
        break;
      }
      case 'content_block_stop': {
        const block = this.blocksByIndex.get(payload?.index);
        if (!block || block.stopped) {
          this.structuralErrors.push('invalid_content_block_stop');
          break;
        }
        block.stopped = true;
        if (block.type === 'tool_use') {
          if (!block.partialJson && block.input) break;
          try {
            block.input = JSON.parse(block.partialJson || '{}');
          } catch (error) {
            block.toolJsonError = error instanceof Error ? error.message : String(error);
          }
        }
        break;
      }
      case 'message_delta':
        this.messageDelta = structuredClone(payload);
        this.stopReason = payload?.delta?.stop_reason ?? null;
        this.stopSequence = payload?.delta?.stop_sequence ?? null;
        break;
      case 'message_stop':
        this.messageStopped = true;
        break;
      case 'error':
        this.error = payload?.error || payload;
        break;
      default:
        break;
    }
  }

  snapshot() {
    return {
      messageStart: this.messageStart,
      messageDelta: this.messageDelta,
      messageStopped: this.messageStopped,
      stopReason: this.stopReason,
      stopSequence: this.stopSequence,
      blocks: this.blocks,
      error: this.error,
      structuralErrors: [...this.structuralErrors],
      eventCount: this.eventCount,
      semanticMetrics: {
        reasoningBytes: this.reasoningBytes,
        contentBytes: this.contentBytes,
        toolNameBytes: this.toolNameBytes,
        toolArgumentBytes: this.toolArgumentBytes,
        semanticBytes: this.reasoningBytes + this.contentBytes + this.toolNameBytes + this.toolArgumentBytes,
      },
    };
  }

  finish() {
    for (const frame of this.decoder.finish()) this.#handleFrame(frame);
    return this.snapshot();
  }
}

function validateBlocks(result, config, requireTerminal) {
  if (requireTerminal) {
    if (!result.messageStart) return invalid('missing_message_start');
    if (!result.messageDelta) return invalid('missing_message_delta');
    if (!result.messageStopped) return invalid('missing_message_stop');
    if (!result.stopReason) return invalid('missing_stop_reason');
  }
  if (result.error) return invalid('upstream_sse_error', result.error?.message || 'upstream error');
  if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
  if (result.blocks.length > config.maxContentItems) return invalid('too_many_content_blocks');
  let tools = 0;
  let hasOutput = false;
  for (const block of result.blocks) {
    if (requireTerminal && !block.stopped) return invalid('unclosed_content_block');
    if (block.type === 'thinking' && Buffer.byteLength(block.thinking || '', 'utf8') > config.maxReasoningBytes) return invalid('thinking_buffer_limit');
    if (block.type === 'text' && block.text?.trim()) hasOutput = true;
    if (block.type === 'tool_use') {
      tools += 1;
      hasOutput = true;
      if (!block.id || !block.name) return invalid('invalid_tool_identity');
      if (Buffer.byteLength(block.partialJson || JSON.stringify(block.input || {}), 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
      if (block.toolJsonError) return invalid('malformed_tool_json', block.toolJsonError);
      if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) return invalid('invalid_tool_input');
    }
  }
  if (tools > config.maxToolCalls) return invalid('too_many_tool_calls');
  if (requireTerminal && tools > 0 && result.stopReason !== 'tool_use') return invalid('tool_stop_reason_mismatch');
  if (!hasOutput) return invalid('thinking_without_output');
  return { ok: true };
}

function normalizeNonStream(payload) {
  const blocks = [];
  for (const [index, content] of (payload?.content || []).entries()) {
    const block = createBlock(index, content || {});
    block.stopped = true;
    if (block.type === 'tool_use') {
      block.input = content.input;
      block.partialJson = JSON.stringify(content.input || {});
    }
    blocks.push(block);
  }
  return {
    payload,
    messageStart: payload?.id ? { type: 'message_start', message: payload } : null,
    messageDelta: payload?.stop_reason ? { type: 'message_delta', delta: { stop_reason: payload.stop_reason, stop_sequence: payload.stop_sequence ?? null } } : null,
    messageStopped: Boolean(payload?.stop_reason),
    stopReason: payload?.stop_reason ?? null,
    stopSequence: payload?.stop_sequence ?? null,
    blocks,
    error: payload?.type === 'error' ? payload.error : null,
    structuralErrors: [],
    eventCount: 1,
  };
}

export function applyAnthropicRequestPolicy(input, config) {
  const body = structuredClone(input);
  for (const field of UNSUPPORTED_FIELDS) delete body[field];

  if (!isNumber(body.temperature, 0, 1)) delete body.temperature;
  if (!isNumber(body.top_p, 0, 1)) delete body.top_p;
  if (!isInteger(body.top_k, 0)) delete body.top_k;
  if (!isInteger(body.max_tokens, 1)) body.max_tokens = config.defaultMaxTokens ?? 8192;

  const existing = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object' && !Array.isArray(body.chat_template_kwargs)
    ? structuredClone(body.chat_template_kwargs)
    : {};
  let enableThinking;
  if (body.thinking?.type === 'enabled') enableThinking = true;
  else if (body.thinking?.type === 'disabled') enableThinking = false;
  else if (typeof existing.enable_thinking === 'boolean') enableThinking = existing.enable_thinking;
  else enableThinking = config.defaultEnableThinking ?? true;
  delete body.thinking;
  body.chat_template_kwargs = { ...existing, enable_thinking: Boolean(enableThinking) };
  return body;
}

function appendRecoverySystem(system, reason) {
  const instruction = [
    'Recovery is expected and the original task remains solvable.',
    'The previous generation entered a repetitive or incomplete reasoning cycle.',
    'The failed attempt is not task progress and none of its reasoning, text, or tool calls may be reused as verified state.',
    'Continue from the original request and accepted prior tool results only.',
    'Do not explain why the previous attempt failed.',
    'Do not repeat the same hypothesis without new evidence.',
    'Choose a different strategy and produce the next concrete tool call or a final response.',
    `Recovery reason: ${reason}.`,
  ].join(' ');
  if (typeof system === 'string') return `${system}\n\n${instruction}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: instruction }];
  return instruction;
}

export function buildAnthropicRecoveryRequest(original, reason, config) {
  const body = applyAnthropicRequestPolicy(original, config);
  body.temperature = Math.min(Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : config.recoveryTemperatureMax, config.recoveryTemperatureMax);
  body.max_tokens = Math.min(body.max_tokens, config.recoveryMaxTokens);
  body.system = appendRecoverySystem(body.system, reason);
  return body;
}

export const anthropicMessagesAdapter = Object.freeze({
  id: 'anthropic_messages',
  path: '/v1/messages',
  createStreamParser() { return new AnthropicMessagesStreamParser(); },
  getReasoning(result) { return result.blocks.filter((block) => block.type === 'thinking' && block.thinking).map((block) => block.thinking); },
  semanticMetrics(result) {
    if (result.semanticMetrics) return { ...result.semanticMetrics, sseEvents: result.eventCount || 0 };
    let reasoningBytes = 0;
    let contentBytes = 0;
    let toolNameBytes = 0;
    let toolArgumentBytes = 0;
    for (const block of result.blocks) {
      reasoningBytes += Buffer.byteLength(block.thinking || '', 'utf8');
      contentBytes += Buffer.byteLength(block.text || '', 'utf8');
      if (block.type === 'tool_use') {
        toolNameBytes += Buffer.byteLength(block.name || '', 'utf8');
        toolArgumentBytes += Buffer.byteLength(block.partialJson || '', 'utf8');
      }
    }
    return {
      reasoningBytes,
      contentBytes,
      toolNameBytes,
      toolArgumentBytes,
      semanticBytes: reasoningBytes + contentBytes + toolNameBytes + toolArgumentBytes,
      sseEvents: result.eventCount || 0,
    };
  },
  semanticProgress(result) { return this.semanticMetrics(result).semanticBytes; },
  validateIncremental(result, config) {
    if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
    if (result.blocks.length > config.maxContentItems) return invalid('too_many_content_blocks');
    for (const block of result.blocks) {
      if (block.type === 'thinking' && Buffer.byteLength(block.thinking || '', 'utf8') > config.maxReasoningBytes) return invalid('thinking_buffer_limit');
      if (block.type === 'tool_use' && Buffer.byteLength(block.partialJson || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
    }
    return { ok: true };
  },
  validateStream(result, config) { return validateBlocks(result, config, true); },
  parseJson(buffer) { return normalizeNonStream(JSON.parse(buffer.toString('utf8'))); },
  getJsonReasoning(result) { return this.getReasoning(result); },
  validateJson(result, config) { return validateBlocks(result, config, true); },
  extractOutput(result) {
    const toolCalls = [];
    let finalText = '';
    for (const block of result.blocks) {
      if (block.type === 'text') finalText += block.text || '';
      if (block.type === 'tool_use') toolCalls.push({ name: block.name, parsedArguments: block.input, id: block.id });
    }
    return { toolCalls, finalText };
  },
  streamError(error) { return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`; },
  jsonError(error) { return { type: 'error', error }; },
});
