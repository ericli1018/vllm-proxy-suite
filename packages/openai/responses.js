import { SseFrameDecoder } from '../core/sse.js';

function invalid(reason, detail = reason) {
  return { ok: false, reason, detail };
}

function createFunctionCall(id, index = 0) {
  return { id, index, name: '', arguments: '', parsedArguments: null, argumentError: null };
}

function finalizeCalls(calls) {
  for (const call of calls.values()) {
    try {
      call.parsedArguments = JSON.parse(call.arguments || '{}');
      call.argumentError = null;
    } catch (error) {
      call.parsedArguments = null;
      call.argumentError = error instanceof Error ? error.message : String(error);
    }
  }
}

class ResponsesStreamParser {
  constructor() {
    this.decoder = new SseFrameDecoder();
    this.completed = false;
    this.failed = false;
    this.error = null;
    this.structuralErrors = [];
    this.reasoning = '';
    this.outputText = '';
    this.functionCalls = new Map();
    this.eventCount = 0;
    this.response = null;
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
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      this.structuralErrors.push('invalid_sse_json');
      return;
    }
    this.eventCount += 1;
    const type = payload?.type || frame.event;
    if (type === 'error' || type === 'response.failed') {
      this.failed = true;
      this.error = payload?.error || payload;
      return;
    }
    if (type === 'response.completed') {
      this.completed = true;
      this.response = payload.response || null;
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof payload.delta === 'string') {
        this.reasoning += payload.delta;
        this.reasoningBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      return;
    }
    if (type === 'response.output_text.delta') {
      if (typeof payload.delta === 'string') {
        this.outputText += payload.delta;
        this.contentBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      return;
    }
    if (type === 'response.output_item.added') {
      const item = payload.item || {};
      if (item.type === 'function_call') {
        const id = item.id || item.call_id || String(payload.output_index ?? this.functionCalls.size);
        const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
        if (typeof item.name === 'string') {
          this.toolNameBytes += Math.max(0, Buffer.byteLength(item.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
          call.name = item.name;
        }
        if (typeof item.arguments === 'string') {
          this.toolArgumentBytes += Math.max(0, Buffer.byteLength(item.arguments, 'utf8') - Buffer.byteLength(call.arguments || '', 'utf8'));
          call.arguments = item.arguments;
        }
        this.functionCalls.set(id, call);
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
      if (typeof payload.delta === 'string') {
        call.arguments += payload.delta;
        this.toolArgumentBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      this.functionCalls.set(id, call);
      return;
    }
    if (type === 'response.output_item.done') {
      const item = payload.item || {};
      if (item.type === 'function_call') {
        const id = item.id || item.call_id || String(payload.output_index ?? 0);
        const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
        if (typeof item.name === 'string') {
          this.toolNameBytes += Math.max(0, Buffer.byteLength(item.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
          call.name = item.name;
        }
        if (typeof item.arguments === 'string') {
          this.toolArgumentBytes += Math.max(0, Buffer.byteLength(item.arguments, 'utf8') - Buffer.byteLength(call.arguments || '', 'utf8'));
          call.arguments = item.arguments;
        }
        this.functionCalls.set(id, call);
      }
    }
  }

  snapshot() {
    return {
      completed: this.completed,
      failed: this.failed,
      error: this.error,
      structuralErrors: [...this.structuralErrors],
      reasoning: this.reasoning,
      outputText: this.outputText,
      functionCalls: this.functionCalls,
      eventCount: this.eventCount,
      response: this.response,
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
    finalizeCalls(this.functionCalls);
    return this.snapshot();
  }
}

function parseReasoningItem(item) {
  let text = '';
  for (const entry of item?.summary || []) if (typeof entry?.text === 'string') text += entry.text;
  for (const entry of item?.content || []) if (entry?.type?.includes('reasoning') && typeof entry?.text === 'string') text += entry.text;
  return text;
}

function normalizeNonStream(payload) {
  let reasoning = '';
  let outputText = '';
  const functionCalls = new Map();
  for (const [index, item] of (payload?.output || []).entries()) {
    if (item?.type === 'reasoning') reasoning += parseReasoningItem(item);
    if (item?.type === 'message') {
      for (const content of item.content || []) if (content?.type === 'output_text' && typeof content.text === 'string') outputText += content.text;
    }
    if (item?.type === 'function_call') {
      const id = item.id || item.call_id || String(index);
      const call = createFunctionCall(id, index);
      call.name = item.name || '';
      call.arguments = item.arguments || '';
      functionCalls.set(id, call);
    }
  }
  finalizeCalls(functionCalls);
  return { payload, completed: payload?.status === 'completed', failed: payload?.status === 'failed', error: payload?.error || null, reasoning, outputText, functionCalls };
}

function validateResult(result, config, requireCompleted) {
  if (requireCompleted && !result.completed) return invalid('missing_response_completed');
  if (result.failed || result.error) return invalid('upstream_response_error', result.error?.message || 'upstream error');
  if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
  if (Buffer.byteLength(result.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
  if (result.functionCalls.size > config.maxToolCalls) return invalid('too_many_tool_calls');
  for (const call of result.functionCalls.values()) {
    if (!call.name) return invalid('missing_tool_name');
    if (Buffer.byteLength(call.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
    if (call.argumentError) return invalid('malformed_tool_arguments', call.argumentError);
    if (!call.parsedArguments || typeof call.parsedArguments !== 'object' || Array.isArray(call.parsedArguments)) return invalid('invalid_tool_arguments');
  }
  if (!result.outputText?.trim() && result.functionCalls.size === 0) return invalid('reasoning_without_output');
  return { ok: true };
}

export const responsesAdapter = Object.freeze({
  id: 'openai_responses',
  path: '/v1/responses',
  createStreamParser() { return new ResponsesStreamParser(); },
  getReasoning(result) { return result.reasoning ? [result.reasoning] : []; },
  semanticMetrics(result) {
    if (result.semanticMetrics) return { ...result.semanticMetrics, sseEvents: result.eventCount || 0 };
    const reasoningBytes = Buffer.byteLength(result.reasoning || '', 'utf8');
    const contentBytes = Buffer.byteLength(result.outputText || '', 'utf8');
    let toolNameBytes = 0;
    let toolArgumentBytes = 0;
    for (const call of result.functionCalls.values()) {
      toolNameBytes += Buffer.byteLength(call.name || '', 'utf8');
      toolArgumentBytes += Buffer.byteLength(call.arguments || '', 'utf8');
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
    if (result.failed || result.error) return invalid('upstream_response_error', result.error?.message || 'upstream error');
    if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
    if (Buffer.byteLength(result.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
    if (result.functionCalls.size > config.maxToolCalls) return invalid('too_many_tool_calls');
    for (const call of result.functionCalls.values()) {
      if (Buffer.byteLength(call.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit');
    }
    return { ok: true };
  },
  validateStream(result, config) { return validateResult(result, config, true); },
  parseJson(buffer) { return normalizeNonStream(JSON.parse(buffer.toString('utf8'))); },
  getJsonReasoning(result) { return result.reasoning ? [result.reasoning] : []; },
  validateJson(result, config) { return validateResult(result, config, true); },
  extractOutput(result) { return { toolCalls: [...result.functionCalls.values()], finalText: result.outputText || '' }; },
  streamError(error) { return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`; },
  jsonError(error) { return { error }; },
});
