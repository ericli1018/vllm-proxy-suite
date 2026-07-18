import { SseFrameDecoder, encodeSseData } from '../core/sse.js';

function invalid(reason, detail = reason) {
  return { ok: false, reason, detail };
}

function createChoice(index) {
  return {
    index,
    content: '',
    reasoning: '',
    finishReason: null,
    toolCalls: new Map(),
  };
}

function createToolCall(index) {
  return {
    index,
    id: null,
    type: 'function',
    name: '',
    arguments: '',
    parsedArguments: null,
    argumentError: null,
  };
}

function contentDeltaText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      return typeof item?.text === 'string' ? item.text : '';
    }).join('');
  }
  return '';
}

function absorbToolCalls(choice, toolCalls) {
  let toolNameBytes = 0;
  let toolArgumentBytes = 0;
  if (!Array.isArray(toolCalls)) return { toolNameBytes, toolArgumentBytes };
  for (const delta of toolCalls) {
    const index = Number.isInteger(delta?.index) ? delta.index : choice.toolCalls.size;
    const tool = choice.toolCalls.get(index) || createToolCall(index);
    if (typeof delta?.id === 'string') tool.id = delta.id;
    if (typeof delta?.type === 'string') tool.type = delta.type;
    if (typeof delta?.function?.name === 'string') {
      tool.name += delta.function.name;
      toolNameBytes += Buffer.byteLength(delta.function.name, 'utf8');
    }
    if (typeof delta?.function?.arguments === 'string') {
      tool.arguments += delta.function.arguments;
      toolArgumentBytes += Buffer.byteLength(delta.function.arguments, 'utf8');
    }
    choice.toolCalls.set(index, tool);
  }
  return { toolNameBytes, toolArgumentBytes };
}

function finalizeTools(choices) {
  for (const choice of choices.values()) {
    for (const tool of choice.toolCalls.values()) {
      try {
        tool.parsedArguments = JSON.parse(tool.arguments || '{}');
        tool.argumentError = null;
      } catch (error) {
        tool.parsedArguments = null;
        tool.argumentError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

class ChatCompletionsStreamParser {
  constructor() {
    this.decoder = new SseFrameDecoder();
    this.done = false;
    this.error = null;
    this.structuralErrors = [];
    this.choices = new Map();
    this.chunkCount = 0;
    this.usage = null;
    this.reasoningBytes = 0;
    this.contentBytes = 0;
    this.toolNameBytes = 0;
    this.toolArgumentBytes = 0;
  }

  push(chunk) {
    for (const frame of this.decoder.push(chunk)) this.#handle(frame);
  }

  #handle(frame) {
    if (frame.incomplete) {
      this.structuralErrors.push('incomplete_sse_frame');
      return;
    }
    if (frame.data === '[DONE]') {
      this.done = true;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      this.structuralErrors.push('invalid_sse_json');
      return;
    }
    this.chunkCount += 1;
    if (payload?.error) {
      this.error = payload.error;
      return;
    }
    if (payload?.usage) this.usage = structuredClone(payload.usage);
    if (!Array.isArray(payload?.choices)) return;
    for (const item of payload.choices) {
      const index = Number.isInteger(item?.index) ? item.index : 0;
      const choice = this.choices.get(index) || createChoice(index);
      const delta = item?.delta || {};
      const contentDelta = contentDeltaText(delta.content);
      choice.content += contentDelta;
      this.contentBytes += Buffer.byteLength(contentDelta, 'utf8');
      if (typeof delta.reasoning === 'string') {
        choice.reasoning += delta.reasoning;
        this.reasoningBytes += Buffer.byteLength(delta.reasoning, 'utf8');
      }
      if (typeof delta.reasoning_content === 'string') {
        choice.reasoning += delta.reasoning_content;
        this.reasoningBytes += Buffer.byteLength(delta.reasoning_content, 'utf8');
      }
      const toolDelta = absorbToolCalls(choice, delta.tool_calls);
      this.toolNameBytes += toolDelta.toolNameBytes;
      this.toolArgumentBytes += toolDelta.toolArgumentBytes;
      if (item?.finish_reason !== undefined && item.finish_reason !== null) choice.finishReason = item.finish_reason;
      this.choices.set(index, choice);
    }
  }

  snapshot() {
    return {
      done: this.done,
      error: this.error,
      structuralErrors: [...this.structuralErrors],
      choices: this.choices,
      chunkCount: this.chunkCount,
      usage: this.usage,
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
    for (const frame of this.decoder.finish()) this.#handle(frame);
    finalizeTools(this.choices);
    return this.snapshot();
  }
}

function validateChoices(choices, config) {
  if (!(choices instanceof Map) || choices.size === 0) return invalid('missing_choices');
  let toolCount = 0;
  let hasOutput = false;
  for (const choice of choices.values()) {
    if (choice.content?.trim()) hasOutput = true;
    if (choice.toolCalls.size > 0) hasOutput = true;
    toolCount += choice.toolCalls.size;
    if (choice.toolCalls.size > 0 && choice.finishReason !== 'tool_calls') return invalid('tool_finish_reason_mismatch');
    for (const tool of choice.toolCalls.values()) {
      if (!tool.name) return invalid('missing_tool_name');
      if (Buffer.byteLength(tool.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
      if (tool.argumentError) return invalid('malformed_tool_arguments', tool.argumentError);
      if (!tool.parsedArguments || typeof tool.parsedArguments !== 'object' || Array.isArray(tool.parsedArguments)) return invalid('invalid_tool_arguments');
    }
  }
  if (toolCount > config.maxToolCalls) return invalid('too_many_tool_calls');
  if (!hasOutput) return invalid('reasoning_without_output');
  return { ok: true };
}

function normalizeNonStream(payload) {
  const choices = new Map();
  if (Array.isArray(payload?.choices)) {
    for (const item of payload.choices) {
      const index = Number.isInteger(item?.index) ? item.index : 0;
      const choice = createChoice(index);
      const message = item?.message || {};
      choice.content = contentDeltaText(message.content);
      if (typeof message.reasoning === 'string') choice.reasoning += message.reasoning;
      if (typeof message.reasoning_content === 'string') choice.reasoning += message.reasoning_content;
      absorbToolCalls(choice, message.tool_calls);
      choice.finishReason = item?.finish_reason ?? null;
      choices.set(index, choice);
    }
  }
  finalizeTools(choices);
  return { payload, choices, error: payload?.error || null, usage: payload?.usage || null };
}

export const chatCompletionsAdapter = Object.freeze({
  id: 'openai_chat_completions',
  path: '/v1/chat/completions',
  createStreamParser() { return new ChatCompletionsStreamParser(); },
  getReasoning(result) { return [...result.choices.values()].map((choice) => choice.reasoning).filter(Boolean); },
  semanticMetrics(result) {
    if (result.semanticMetrics) {
      return { ...result.semanticMetrics, sseEvents: (result.chunkCount || 0) + (result.done ? 1 : 0) };
    }
    let reasoningBytes = 0;
    let contentBytes = 0;
    let toolNameBytes = 0;
    let toolArgumentBytes = 0;
    for (const choice of result.choices.values()) {
      reasoningBytes += Buffer.byteLength(choice.reasoning || '', 'utf8');
      contentBytes += Buffer.byteLength(choice.content || '', 'utf8');
      for (const tool of choice.toolCalls.values()) {
        toolNameBytes += Buffer.byteLength(tool.name || '', 'utf8');
        toolArgumentBytes += Buffer.byteLength(tool.arguments || '', 'utf8');
      }
    }
    return {
      reasoningBytes,
      contentBytes,
      toolNameBytes,
      toolArgumentBytes,
      semanticBytes: reasoningBytes + contentBytes + toolNameBytes + toolArgumentBytes,
      sseEvents: (result.chunkCount || 0) + (result.done ? 1 : 0),
    };
  },
  semanticProgress(result) { return this.semanticMetrics(result).semanticBytes; },
  validateIncremental(result, config) {
    if (result.error) return invalid('upstream_sse_error', result.error.message || 'upstream error');
    if (result.structuralErrors.length) return invalid(result.structuralErrors[0]);
    for (const choice of result.choices.values()) {
      if (Buffer.byteLength(choice.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
      for (const tool of choice.toolCalls.values()) {
        if (Buffer.byteLength(tool.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
      }
    }
    return { ok: true };
  },
  validateStream(result, config) {
    if (!result.done) return invalid('missing_done');
    if (result.error) return invalid('upstream_sse_error', result.error.message || 'upstream error');
    if (result.structuralErrors.length) return invalid(result.structuralErrors[0]);
    return validateChoices(result.choices, config);
  },
  parseJson(buffer) {
    return normalizeNonStream(JSON.parse(buffer.toString('utf8')));
  },
  getJsonReasoning(result) { return [...result.choices.values()].map((choice) => choice.reasoning).filter(Boolean); },
  validateJson(result, config) {
    if (result.error) return invalid('upstream_json_error', result.error.message || 'upstream error');
    return validateChoices(result.choices, config);
  },
  extractOutput(result) {
    const toolCalls = [];
    let finalText = '';
    for (const choice of result.choices.values()) {
      finalText += choice.content || '';
      for (const tool of choice.toolCalls.values()) toolCalls.push(tool);
    }
    return { toolCalls, finalText };
  },
  streamError(error) {
    return `${encodeSseData({ error })}${encodeSseData('[DONE]')}`;
  },
  jsonError(error) { return { error }; },
});
