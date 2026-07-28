import { classifyJsonParseError } from '../core/json-diagnostics.js';
import { SseFrameDecoder } from '../core/sse.js';

function invalid(reason, detail = reason, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

function createFunctionCall(id, index = 0, kind = 'function') {
  return { id, index, kind, callId: null, name: '', arguments: '', parsedArguments: null, argumentError: null, argumentErrorDiagnostics: null, nameFragmentCount: 0, argumentFragmentCount: 0, nameBytes: 0, argumentBytes: 0, argumentsRetainedBytes: 0, argumentsObservationTruncated: false };
}

function utf8Prefix(value, maxBytes) {
  if (!Number.isFinite(maxBytes)) return String(value || '');
  const limit = Math.max(0, Math.floor(maxBytes));
  let output = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > limit) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function finalizeCalls(calls) {
  for (const call of calls.values()) {
    if (call.kind === 'custom') {
      call.parsedArguments = { __arg1: call.arguments || '' };
      call.argumentError = null;
      call.argumentErrorDiagnostics = null;
      continue;
    }
    if (call.argumentsObservationTruncated) {
      call.parsedArguments = null;
      call.argumentError = null;
      call.argumentErrorDiagnostics = {
        parseErrorCategory: 'observation_truncated',
        parseErrorOffset: null,
        parseErrorLine: null,
        parseErrorColumn: null,
        parseErrorOffsetUnit: null,
        toolArgumentUtf8Bytes: call.argumentBytes,
        toolArgumentRetainedBytes: call.argumentsRetainedBytes,
        toolArgumentObservationTruncated: true,
      };
      continue;
    }
    try {
      call.parsedArguments = JSON.parse(call.arguments || '{}');
      call.argumentError = null;
      call.argumentErrorDiagnostics = null;
    } catch (error) {
      call.parsedArguments = null;
      call.argumentError = error instanceof Error ? error.message : String(error);
      call.argumentErrorDiagnostics = classifyJsonParseError(error, call.arguments);
    }
  }
}

function collectFunctionCallDiagnostics(functionCalls) {
  const toolCalls = [...functionCalls.values()].map((call) => ({
    key: `output:${call.index}/call:${call.id}`,
    index: call.index,
    id: call.id || null,
    name: call.name || 'unknown',
    kind: call.kind || 'function',
    argumentBytes: call.argumentBytes || 0,
    argumentFragments: call.argumentFragmentCount || 0,
    nameFragments: call.nameFragmentCount || 0,
    argumentRetainedBytes: call.argumentsRetainedBytes ?? Buffer.byteLength(call.arguments || '', 'utf8'),
    argumentsObservationTruncated: Boolean(call.argumentsObservationTruncated),
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

function normalizedUsage(usage) {
  const prompt = Number.isFinite(Number(usage?.input_tokens)) ? Number(usage.input_tokens) : null;
  const completion = Number.isFinite(Number(usage?.output_tokens)) ? Number(usage.output_tokens) : null;
  const total = Number.isFinite(Number(usage?.total_tokens))
    ? Number(usage.total_tokens)
    : (prompt !== null && completion !== null ? prompt + completion : null);
  return {
    usagePromptTokens: prompt,
    usageCompletionTokens: completion,
    usageTotalTokens: total,
  };
}

function collectCompletionDiagnostics(result) {
  const response = result?.response || result?.payload || null;
  const status = response?.status ?? null;
  const incompleteDetails = response?.incomplete_details ?? null;
  return {
    responseTerminal: typeof result?.terminal === 'boolean' ? result.terminal : null,
    responseTerminalEvent: result?.terminalEvent ?? null,
    responseCompleted: typeof result?.completed === 'boolean' ? result.completed : null,
    responseIncomplete: typeof result?.incomplete === 'boolean' ? result.incomplete : null,
    responseCancelled: typeof result?.cancelled === 'boolean' ? result.cancelled : null,
    responseFailed: typeof result?.failed === 'boolean' ? result.failed : null,
    responseStatus: status,
    responseIncompleteReason: incompleteDetails?.reason ?? null,
    responseIncompleteDetails: incompleteDetails,
    ...normalizedUsage(response?.usage || result?.payload?.usage),
  };
}

function withCompletionDiagnostics(result, validation) {
  if (validation?.ok) return validation;
  return {
    ...validation,
    diagnostics: {
      ...collectCompletionDiagnostics(result),
      ...(validation?.diagnostics || {}),
    },
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
  constructor(config = {}) {
    this.decoder = new SseFrameDecoder();
    this.terminal = false;
    this.terminalEvent = null;
    this.completed = false;
    this.incomplete = false;
    this.cancelled = false;
    this.failed = false;
    this.error = null;
    this.structuralErrors = [];
    this.reasoning = '';
    this.outputText = '';
    this.refusalText = '';
    this.reasoningParts = new Map();
    this.outputTextParts = new Map();
    this.refusalParts = new Map();
    this.functionCalls = new Map();
    this.eventCount = 0;
    this.response = null;
    this.reasoningBytes = 0;
    this.contentBytes = 0;
    this.toolNameBytes = 0;
    this.toolArgumentBytes = 0;
    this.toolPassthroughObservationOnly = false;
    this.toolPassthroughObservationMaxBytes = Number.isFinite(config.toolPassthroughObservationMaxBytes)
      ? Math.max(0, config.toolPassthroughObservationMaxBytes)
      : 64 * 1024;
  }

  #contentKey(payload, kind) {
    return `${kind}:${payload?.output_index ?? 0}:${payload?.item_id ?? 'unknown'}:${payload?.content_index ?? payload?.summary_index ?? 0}`;
  }

  #syncText(target, property) {
    this[property] = [...target.values()].join('');
  }

  #appendText(target, property, payload, kind, value) {
    if (typeof value !== 'string') return;
    const key = this.#contentKey(payload, kind);
    target.set(key, `${target.get(key) || ''}${value}`);
    this.#syncText(target, property);
  }

  #replaceText(target, property, payload, kind, value) {
    if (typeof value !== 'string') return;
    target.set(this.#contentKey(payload, kind), value);
    this.#syncText(target, property);
  }

  #replaceTrackedText(target, property, metricProperty, payload, kind, value) {
    const previousBytes = Buffer.byteLength(this[property] || '', 'utf8');
    this.#replaceText(target, property, payload, kind, value);
    const nextBytes = Buffer.byteLength(this[property] || '', 'utf8');
    this[metricProperty] += Math.max(0, nextBytes - previousBytes);
  }

  #setTerminal(type, response = null) {
    this.terminal = true;
    this.terminalEvent = type;
    if (response) this.response = response;
    const status = response?.status || (type === 'response.incomplete' ? 'incomplete' : type === 'response.failed' ? 'failed' : type === 'response.completed' ? 'completed' : null);
    this.completed = status === 'completed';
    this.incomplete = status === 'incomplete';
    this.cancelled = status === 'cancelled';
    this.failed = status === 'failed';
    if (this.failed) this.error = response?.error || this.error;
    for (const [outputIndex, item] of (response?.output || []).entries()) this.#ingestOutputItem(item, outputIndex);
  }

  #ingestOutputItem(item, outputIndex = 0) {
    if (!item || typeof item !== 'object') return;
    const base = { output_index: outputIndex, item_id: item.id || item.call_id || String(outputIndex) };
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const id = item.id || item.call_id || String(outputIndex);
      const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
      const call = this.functionCalls.get(id) || createFunctionCall(id, outputIndex, kind);
      call.kind = kind;
      call.callId = item.call_id || call.callId;
      if (typeof item.name === 'string') {
        this.toolNameBytes += Math.max(0, Buffer.byteLength(item.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
        if (item.name !== call.name) call.nameFragmentCount += 1;
        call.name = item.name;
        call.nameBytes = Buffer.byteLength(item.name, 'utf8');
      }
      const value = kind === 'custom' ? item.input : item.arguments;
      if (typeof value === 'string') this.#replaceArguments(call, value);
      this.functionCalls.set(id, call);
      return;
    }
    if (item.type === 'reasoning') {
      for (const [summaryIndex, entry] of (item.summary || []).entries()) {
        if (typeof entry?.text === 'string') this.#replaceTrackedText(this.reasoningParts, 'reasoning', 'reasoningBytes', { ...base, summary_index: summaryIndex }, 'reasoning_summary', entry.text);
      }
      for (const [contentIndex, entry] of (item.content || []).entries()) {
        if (entry?.type?.includes('reasoning') && typeof entry.text === 'string') this.#replaceTrackedText(this.reasoningParts, 'reasoning', 'reasoningBytes', { ...base, content_index: contentIndex }, 'reasoning_text', entry.text);
      }
      return;
    }
    if (item.type === 'message') {
      for (const [contentIndex, content] of (item.content || []).entries()) {
        const contentPayload = { ...base, content_index: contentIndex };
        if (content?.type === 'output_text' && typeof content.text === 'string') this.#replaceTrackedText(this.outputTextParts, 'outputText', 'contentBytes', contentPayload, 'output_text', content.text);
        if (content?.type === 'refusal' && typeof content.refusal === 'string') this.#replaceTrackedText(this.refusalParts, 'refusalText', 'contentBytes', contentPayload, 'refusal', content.refusal);
      }
    }
  }

  enableToolPassthroughObservation(maxBytes = this.toolPassthroughObservationMaxBytes) {
    this.toolPassthroughObservationOnly = true;
    this.toolPassthroughObservationMaxBytes = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : this.toolPassthroughObservationMaxBytes;
    for (const call of this.functionCalls.values()) {
      const retained = utf8Prefix(call.arguments, this.toolPassthroughObservationMaxBytes);
      if (Buffer.byteLength(retained, 'utf8') < Buffer.byteLength(call.arguments || '', 'utf8') || call.argumentBytes > Buffer.byteLength(retained, 'utf8')) {
        call.argumentsObservationTruncated = true;
      }
      call.arguments = retained;
      call.argumentsRetainedBytes = Buffer.byteLength(retained, 'utf8');
    }
  }

  #replaceArguments(call, value) {
    const text = String(value || '');
    const totalBytes = Buffer.byteLength(text, 'utf8');
    if (this.toolPassthroughObservationOnly) {
      const previousBytes = call.argumentBytes || 0;
      const deltaBytes = Math.max(0, totalBytes - previousBytes);
      if (deltaBytes > 0) call.argumentFragmentCount += 1;
      call.argumentBytes = Math.max(previousBytes, totalBytes);
      this.toolArgumentBytes += deltaBytes;
      call.arguments = utf8Prefix(text, this.toolPassthroughObservationMaxBytes);
      call.argumentsRetainedBytes = Buffer.byteLength(call.arguments, 'utf8');
      if (call.argumentsRetainedBytes < totalBytes) call.argumentsObservationTruncated = true;
      return;
    }
    const previousRetainedBytes = call.argumentsRetainedBytes;
    const deltaBytes = Math.max(0, totalBytes - previousRetainedBytes);
    if (deltaBytes > 0) call.argumentFragmentCount += 1;
    this.toolArgumentBytes += deltaBytes;
    call.arguments = text;
    call.argumentBytes = totalBytes;
    call.argumentsRetainedBytes = totalBytes;
  }

  #appendArguments(call, value) {
    const text = String(value || '');
    const argumentBytes = Buffer.byteLength(text, 'utf8');
    call.argumentFragmentCount += 1;
    call.argumentBytes += argumentBytes;
    this.toolArgumentBytes += argumentBytes;
    if (this.toolPassthroughObservationOnly) {
      const remainingBytes = Math.max(0, this.toolPassthroughObservationMaxBytes - call.argumentsRetainedBytes);
      const retained = utf8Prefix(text, remainingBytes);
      const retainedBytes = Buffer.byteLength(retained, 'utf8');
      call.arguments += retained;
      call.argumentsRetainedBytes += retainedBytes;
      if (retainedBytes < argumentBytes) call.argumentsObservationTruncated = true;
    } else {
      call.arguments += text;
      call.argumentsRetainedBytes += argumentBytes;
    }
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
    if (type === 'error') {
      this.terminal = true;
      this.terminalEvent = type;
      this.failed = true;
      this.error = payload?.error || payload?.response?.error || payload;
      if (payload?.response) this.response = payload.response;
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      this.#setTerminal(type, payload.response || null);
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (typeof payload.delta === 'string') {
        this.#appendText(this.reasoningParts, 'reasoning', payload, type.includes('summary') ? 'reasoning_summary' : 'reasoning_text', payload.delta);
        this.reasoningBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      return;
    }
    if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
      this.#replaceTrackedText(this.reasoningParts, 'reasoning', 'reasoningBytes', payload, type.includes('summary') ? 'reasoning_summary' : 'reasoning_text', payload.text);
      return;
    }
    if (type === 'response.output_text.delta') {
      if (typeof payload.delta === 'string') {
        this.#appendText(this.outputTextParts, 'outputText', payload, 'output_text', payload.delta);
        this.contentBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      return;
    }
    if (type === 'response.output_text.done') {
      this.#replaceTrackedText(this.outputTextParts, 'outputText', 'contentBytes', payload, 'output_text', payload.text);
      return;
    }
    if (type === 'response.refusal.delta') {
      if (typeof payload.delta === 'string') {
        this.#appendText(this.refusalParts, 'refusalText', payload, 'refusal', payload.delta);
        this.contentBytes += Buffer.byteLength(payload.delta, 'utf8');
      }
      return;
    }
    if (type === 'response.refusal.done') {
      this.#replaceTrackedText(this.refusalParts, 'refusalText', 'contentBytes', payload, 'refusal', payload.refusal);
      return;
    }
    if (type === 'response.output_item.added') {
      const item = payload.item || {};
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const id = item.id || item.call_id || String(payload.output_index ?? this.functionCalls.size);
        const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
        const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0, kind);
        call.kind = kind;
        call.callId = item.call_id || call.callId;
        if (typeof item.name === 'string') {
          this.toolNameBytes += Math.max(0, Buffer.byteLength(item.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
          if (item.name !== call.name) call.nameFragmentCount += 1;
          call.name = item.name;
          call.nameBytes = Buffer.byteLength(item.name, 'utf8');
        }
        const value = kind === 'custom' ? item.input : item.arguments;
        if (typeof value === 'string') this.#replaceArguments(call, value);
        this.functionCalls.set(id, call);
      }
      return;
    }
    if (type === 'response.custom_tool_call_input.delta') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0, 'custom');
      call.kind = 'custom';
      if (typeof payload.delta === 'string') this.#appendArguments(call, payload.delta);
      this.functionCalls.set(id, call);
      return;
    }
    if (type === 'response.custom_tool_call_input.done') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0, 'custom');
      call.kind = 'custom';
      if (typeof payload.name === 'string') {
        this.toolNameBytes += Math.max(0, Buffer.byteLength(payload.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
        call.name = payload.name;
        call.nameBytes = Buffer.byteLength(payload.name, 'utf8');
      }
      if (typeof payload.input === 'string') this.#replaceArguments(call, payload.input);
      this.functionCalls.set(id, call);
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
      if (typeof payload.delta === 'string') this.#appendArguments(call, payload.delta);
      this.functionCalls.set(id, call);
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const id = payload.item_id || payload.call_id || String(payload.output_index ?? 0);
      const call = this.functionCalls.get(id) || createFunctionCall(id, payload.output_index ?? 0);
      if (typeof payload.name === 'string') {
        this.toolNameBytes += Math.max(0, Buffer.byteLength(payload.name, 'utf8') - Buffer.byteLength(call.name || '', 'utf8'));
        if (payload.name !== call.name) call.nameFragmentCount += 1;
        call.name = payload.name;
        call.nameBytes = Buffer.byteLength(payload.name, 'utf8');
      }
      if (typeof payload.arguments === 'string') this.#replaceArguments(call, payload.arguments);
      this.functionCalls.set(id, call);
      return;
    }
    if (type === 'response.output_item.done') {
      const item = payload.item || {};
      this.#ingestOutputItem(item, payload.output_index ?? 0);
    }
  }

  snapshot() {
    return {
      terminal: this.terminal,
      terminalEvent: this.terminalEvent,
      completed: this.completed,
      incomplete: this.incomplete,
      cancelled: this.cancelled,
      failed: this.failed,
      error: this.error,
      structuralErrors: [...this.structuralErrors],
      reasoning: this.reasoning,
      outputText: this.outputText,
      refusalText: this.refusalText,
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
        ...collectCompletionDiagnostics({
          terminal: this.terminal,
          terminalEvent: this.terminalEvent,
          completed: this.completed,
          incomplete: this.incomplete,
          cancelled: this.cancelled,
          failed: this.failed,
          response: this.response,
        }),
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
  let refusalText = '';
  const functionCalls = new Map();
  for (const [index, item] of (payload?.output || []).entries()) {
    if (item?.type === 'reasoning') reasoning += parseReasoningItem(item);
    if (item?.type === 'message') {
      for (const content of item.content || []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') outputText += content.text;
        if (content?.type === 'refusal' && typeof content.refusal === 'string') refusalText += content.refusal;
      }
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const id = item.id || item.call_id || String(index);
      const kind = item.type === 'custom_tool_call' ? 'custom' : 'function';
      const call = createFunctionCall(id, index, kind);
      call.callId = item.call_id || null;
      call.name = item.name || '';
      call.arguments = kind === 'custom' ? (item.input || '') : (item.arguments || '');
      call.nameFragmentCount = call.name ? 1 : 0;
      call.argumentFragmentCount = call.arguments ? 1 : 0;
      call.nameBytes = Buffer.byteLength(call.name, 'utf8');
      call.argumentBytes = Buffer.byteLength(call.arguments, 'utf8');
      call.argumentsRetainedBytes = call.argumentBytes;
      functionCalls.set(id, call);
    }
  }
  finalizeCalls(functionCalls);
  const status = payload?.status ?? null;
  return {
    payload,
    terminal: ['completed', 'incomplete', 'failed', 'cancelled'].includes(status),
    terminalEvent: null,
    completed: status === 'completed',
    incomplete: status === 'incomplete',
    cancelled: status === 'cancelled',
    failed: status === 'failed',
    error: payload?.error || null,
    reasoning,
    outputText,
    refusalText,
    functionCalls,
  };
}

function validateResult(result, config, requireTerminal) {
  if (requireTerminal && !result.terminal) return invalid('missing_response_terminal');
  if (result.failed || result.error) return invalid('upstream_response_error', result.error?.message || 'upstream error');
  if (result.structuralErrors?.length) return invalid(result.structuralErrors[0]);
  if (Buffer.byteLength(result.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
  if (result.functionCalls.size > config.maxToolCalls) return invalid('too_many_tool_calls', 'too_many_tool_calls', { retryable: false, diagnostics: collectFunctionCallDiagnostics(result.functionCalls) });
  for (const call of result.functionCalls.values()) {
    if (!call.name) return invalid('missing_tool_name');
    if (call.argumentsObservationTruncated) continue;
    if (Buffer.byteLength(call.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit', 'tool_argument_limit', { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
    if (call.kind !== 'custom' && call.argumentError) return invalid('malformed_tool_arguments', call.argumentError, { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
    if (call.kind !== 'custom' && (!call.parsedArguments || typeof call.parsedArguments !== 'object' || Array.isArray(call.parsedArguments))) return invalid('invalid_tool_arguments', 'invalid_tool_arguments', { retryable: false, diagnostics: malformedCallDiagnostics(result.functionCalls, call) });
  }
  if (result.incomplete || result.cancelled) return { ok: true };
  if (!result.outputText?.trim() && !result.refusalText?.trim() && result.functionCalls.size === 0) return invalid('reasoning_without_output');
  return { ok: true };
}

export const responsesAdapter = Object.freeze({
  id: 'openai_responses',
  path: '/v1/responses',
  createStreamParser(config) { return new ResponsesStreamParser(config); },
  getReasoning(result) { return result.reasoning ? [result.reasoning] : []; },
  shouldDetectReasoningLoop(_result, semantic) {
    return !semantic.responseTerminal
      && semantic.contentBytes === 0
      && semantic.toolCallCount === 0;
  },
  completionDiagnostics(result) { return collectCompletionDiagnostics(result); },
  semanticMetrics(result) {
    if (result.semanticMetrics) return { ...result.semanticMetrics, sseEvents: result.eventCount || 0 };
    const reasoningBytes = Buffer.byteLength(result.reasoning || '', 'utf8');
    const contentBytes = Buffer.byteLength(result.outputText || '', 'utf8') + Buffer.byteLength(result.refusalText || '', 'utf8');
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
      ...collectCompletionDiagnostics(result),
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
  validateStream(result, config) { return withCompletionDiagnostics(result, validateResult(result, config, true)); },
  parseJson(buffer) { return normalizeNonStream(JSON.parse(buffer.toString('utf8'))); },
  getJsonReasoning(result) { return result.reasoning ? [result.reasoning] : []; },
  validateJson(result, config) { return withCompletionDiagnostics(result, validateResult(result, config, true)); },
  extractOutput(result) { return { toolCalls: [...result.functionCalls.values()], finalText: result.outputText || result.refusalText || '' }; },
  streamError(error) { return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`; },
  jsonError(error) { return { error }; },
});
