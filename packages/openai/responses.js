import { classifyJsonParseError } from '../core/json-diagnostics.js';
import { SseFrameDecoder } from '../core/sse.js';

function invalid(reason, detail = reason, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

function createFunctionCall(id, index = 0) {
  return { id, index, name: '', arguments: '', parsedArguments: null, argumentError: null, argumentErrorDiagnostics: null, nameFragmentCount: 0, argumentFragmentCount: 0, nameBytes: 0, argumentBytes: 0 };
}

function finalizeCalls(calls) {
  for (const call of calls.values()) {
    try {
      call.parsedArguments = JSON.parse(call.arguments || '{}');
      call.argumentError = null;
      call.argumentErrorDiagnostics = null;
    } catch (error) {
      call.parsedArguments = null;
      call.argumentError = error instanceof Error ? error.message : String(error);
      call.argumentErrorDiagnostics = classifyJsonParseError(error);
    }
  }
}

function collectFunctionCallDiagnostics(functionCalls) {
  const toolCalls = [...functionCalls.values()].map((call) => ({
    key: `output:${call.index}/call:${call.id}`,
    index: call.index,
    id: call.id || null,
    name: call.name || 'unknown',
    argumentBytes: call.argumentBytes || 0,
    argumentFragments: call.argumentFragmentCount || 0,
    nameFragments: call.nameFragmentCount || 0,
  })).sort((a, b) => a.index - b.index || a.key.localeCompare(b.key));
  return {
    toolCallCount: toolCalls.length,
    toolCallIndexes: [...new Set(toolCalls.map((tool) => tool.index))],
    toolCallKeys: toolCalls.map((tool) => tool.key),
    toolCallIds: toolCalls.map((tool) => tool.id).filter(Boolean),
    toolNames: toolCalls.map((tool) => tool.name),
    toolArgumentBytesByCall: Object.fromEntries(toolCalls.map((tool) => [tool.key, tool.argumentBytes])),
    toolArgumentFragmentsByCall: Object.fromEntries(toolCalls.map((tool) => [tool.key, tool.argumentFragments])),
    parallelToolCallsDetected: toolCalls.length > 1,
    toolCalls,
  };
}

function malformedCallDiagnostics(functionCalls, call) {
  return {
    ...collectFunctionCallDiagnostics(functionCalls),
    toolCallKey: `output:${call.index}/call:${call.id}`,
    toolCallIndex: call.index,
    toolCallId: call.id || null,
    toolName: call.name || 'unknown',
    toolArgumentBytes: call.argumentBytes || 0,
    toolArgumentFragments: call.argumentFragmentCount || 0,
    ...call.argumentErrorDiagnostics,
  };
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
          if (item.name !== call.name) call.nameFragmentCount += 1;
          call.name = item.name;
          call.nameBytes = Buffer.byteLength(item.name, 'utf8');
        }
        if (typeof item.arguments === 'string') {
          const argumentDeltaBytes = Math.max(0, Buffer.byteLength(item.arguments, 'utf8') - Buffer.byteLength(call.arguments || '', 'utf8'));
          this.toolArgumentBytes += argumentDeltaBytes;
          if (argumentDeltaBytes > 0) call.argumentFragmentCount += 1;
          call.arguments = item.arguments;
          call.argumentBytes = Buffer.byteLength(item.arguments, 'utf8');
        }
        this.functionCalls.set(id, call);
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
      if (typeof payload.delta === 'string') {
        const argumentBytes = Buffer.byteLength(payload.delta, 'utf8');
        call.arguments += payload.delta;
        call.argumentFragmentCount += 1;
        call.argumentBytes += argumentBytes;
        this.toolArgumentBytes += argumentBytes;
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
          if (item.name !== call.name) call.nameFragmentCount += 1;
          call.name = item.name;
          call.nameBytes = Buffer.byteLength(item.name, 'utf8');
        }
        if (typeof item.arguments === 'string') {
          const argumentDeltaBytes = Math.max(0, Buffer.byteLength(item.arguments, 'utf8') - Buffer.byteLength(call.arguments || '', 'utf8'));
          this.toolArgumentBytes += argumentDeltaBytes;
          if (argumentDeltaBytes > 0) call.argumentFragmentCount += 1;
          call.arguments = item.arguments;
          call.argumentBytes = Buffer.byteLength(item.arguments, 'utf8');
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
        ...collectFunctionCallDiagnostics(this.functionCalls),
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
      call.nameFragmentCount = call.name ? 1 : 0;
      call.argumentFragmentCount = call.arguments ? 1 : 0;
      call.nameBytes = Buffer.byteLength(call.name, 'utf8');
      call.argumentBytes = Buffer.byteLength(call.arguments, 'utf8');
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
  if (result.functionCalls.size > config.maxToolCalls) return invalid('too_many_tool_calls', 'too_many_tool_calls', { retryable: false, diagnostics: collectFunctionCallDiagnostics(result.functionCalls) });
  for (const call of result.functionCalls.values()) {
    if (!call.name) return invalid('missing_tool_name');
    if (Buffer.byteLength(call.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit', 'tool_argument_limit', { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
    if (call.argumentError) return invalid('malformed_tool_arguments', call.argumentError, { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
    if (!call.parsedArguments || typeof call.parsedArguments !== 'object' || Array.isArray(call.parsedArguments)) return invalid('invalid_tool_arguments', 'invalid_tool_arguments', { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
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
      ...collectFunctionCallDiagnostics(result.functionCalls),
    };
  },
  semanticProgress(result) { return this.semanticMetrics(result).semanticBytes; },
  validateIncremental(result, config) {
    if (result.failed || result.error) return invalid('upstream_response_error', result.error?.message || 'upstream error');
    if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
    if (Buffer.byteLength(result.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
    if (result.functionCalls.size > config.maxToolCalls) return invalid('too_many_tool_calls', 'too_many_tool_calls', { retryable: false, diagnostics: collectFunctionCallDiagnostics(result.functionCalls) });
    for (const call of result.functionCalls.values()) {
      if (Buffer.byteLength(call.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit', 'tool_argument_limit', { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
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
