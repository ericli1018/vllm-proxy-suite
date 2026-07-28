import { classifyJsonParseError } from '../core/json-diagnostics.js';
import { SseFrameDecoder, encodeSseData } from '../core/sse.js';

function invalid(reason, detail = reason, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

function createChoice(index) {
  return {
    index,
    content: '',
    reasoning: '',
    finishReason: null,
    toolCalls: new Map(),
    lastToolCallIndex: null,
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
    argumentErrorDiagnostics: null,
    nameFragmentCount: 0,
    argumentFragmentCount: 0,
    nameBytes: 0,
    argumentBytes: 0,
    argumentsRetainedBytes: 0,
    argumentsObservationTruncated: false,
  };
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

function nextToolCallIndex(choice) {
  if (choice.toolCalls.size === 0) return 0;
  return Math.max(...choice.toolCalls.keys()) + 1;
}

function resolveToolCallIndex(choice, delta, position, deltaCount) {
  if (Number.isInteger(delta?.index)) return delta.index;
  if (typeof delta?.id === 'string') {
    for (const [index, tool] of choice.toolCalls.entries()) {
      if (tool.id === delta.id) return index;
    }
    return nextToolCallIndex(choice);
  }
  if (deltaCount === 1 && choice.lastToolCallIndex !== null && choice.toolCalls.has(choice.lastToolCallIndex)) {
    return choice.lastToolCallIndex;
  }
  const existingIndexes = [...choice.toolCalls.keys()].sort((a, b) => a - b);
  if (position < existingIndexes.length) return existingIndexes[position];
  return nextToolCallIndex(choice);
}

function absorbToolCalls(choice, toolCalls, observationMaxBytes = null) {
  let toolNameBytes = 0;
  let toolArgumentBytes = 0;
  if (!Array.isArray(toolCalls)) return { toolNameBytes, toolArgumentBytes };
  for (const [position, delta] of toolCalls.entries()) {
    const index = resolveToolCallIndex(choice, delta, position, toolCalls.length);
    const tool = choice.toolCalls.get(index) || createToolCall(index);
    if (typeof delta?.id === 'string') tool.id = delta.id;
    if (typeof delta?.type === 'string') tool.type = delta.type;
    if (typeof delta?.function?.name === 'string') {
      const nameBytes = Buffer.byteLength(delta.function.name, 'utf8');
      tool.name += delta.function.name;
      tool.nameFragmentCount += 1;
      tool.nameBytes += nameBytes;
      toolNameBytes += nameBytes;
    }
    if (typeof delta?.function?.arguments === 'string') {
      const argumentBytes = Buffer.byteLength(delta.function.arguments, 'utf8');
      if (Number.isFinite(observationMaxBytes)) {
        const remainingBytes = Math.max(0, observationMaxBytes - tool.argumentsRetainedBytes);
        const retainedFragment = utf8Prefix(delta.function.arguments, remainingBytes);
        const retainedFragmentBytes = Buffer.byteLength(retainedFragment, 'utf8');
        tool.arguments += retainedFragment;
        tool.argumentsRetainedBytes += retainedFragmentBytes;
        if (retainedFragmentBytes < argumentBytes) tool.argumentsObservationTruncated = true;
      } else {
        tool.arguments += delta.function.arguments;
        tool.argumentsRetainedBytes += argumentBytes;
      }
      tool.argumentFragmentCount += 1;
      tool.argumentBytes += argumentBytes;
      toolArgumentBytes += argumentBytes;
    }
    choice.toolCalls.set(index, tool);
    choice.lastToolCallIndex = index;
  }
  return { toolNameBytes, toolArgumentBytes };
}

function finalizeTools(choices) {
  for (const choice of choices.values()) {
    for (const tool of choice.toolCalls.values()) {
      if (tool.argumentsObservationTruncated) {
        tool.parsedArguments = null;
        tool.argumentError = null;
        tool.argumentErrorDiagnostics = {
          parseErrorCategory: 'observation_truncated',
          parseErrorOffset: null,
          parseErrorLine: null,
          parseErrorColumn: null,
          parseErrorOffsetUnit: null,
          toolArgumentUtf8Bytes: tool.argumentBytes,
          toolArgumentRetainedBytes: tool.argumentsRetainedBytes,
          toolArgumentObservationTruncated: true,
        };
        continue;
      }
      try {
        tool.parsedArguments = JSON.parse(tool.arguments || '{}');
        tool.argumentError = null;
        tool.argumentErrorDiagnostics = null;
      } catch (error) {
        tool.parsedArguments = null;
        tool.argumentError = error instanceof Error ? error.message : String(error);
        tool.argumentErrorDiagnostics = classifyJsonParseError(error, tool.arguments);
      }
    }
  }
}

function collectToolDiagnostics(choices) {
  const toolCalls = [];
  for (const [choiceIndex, choice] of choices.entries()) {
    for (const [toolIndex, tool] of choice.toolCalls.entries()) {
      toolCalls.push({
        key: `choice:${choiceIndex}/tool:${toolIndex}`,
        choiceIndex,
        index: toolIndex,
        id: tool.id || null,
        name: tool.name || 'unknown',
        argumentBytes: tool.argumentBytes || 0,
        argumentFragments: tool.argumentFragmentCount || 0,
        nameFragments: tool.nameFragmentCount || 0,
        argumentRetainedBytes: tool.argumentsRetainedBytes ?? Buffer.byteLength(tool.arguments || '', 'utf8'),
        argumentsObservationTruncated: Boolean(tool.argumentsObservationTruncated),
      });
    }
  }
  toolCalls.sort((a, b) => a.choiceIndex - b.choiceIndex || a.index - b.index);
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
  const prompt = Number.isFinite(Number(usage?.prompt_tokens)) ? Number(usage.prompt_tokens) : null;
  const completion = Number.isFinite(Number(usage?.completion_tokens)) ? Number(usage.completion_tokens) : null;
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
  const choices = result?.choices instanceof Map ? result.choices : new Map();
  const finishReasonsByChoice = Object.fromEntries([...choices.entries()].map(([index, choice]) => [String(index), choice.finishReason ?? null]));
  const finishReasons = Object.values(finishReasonsByChoice);
  return {
    doneReceived: typeof result?.done === 'boolean' ? result.done : null,
    finishReason: finishReasons.length === 1 ? finishReasons[0] : null,
    finishReasonsByChoice,
    ...normalizedUsage(result?.usage),
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

class ChatCompletionsStreamParser {
  constructor(config = {}) {
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
    this.toolPassthroughObservationOnly = false;
    this.toolPassthroughObservationMaxBytes = Number.isFinite(config.toolPassthroughObservationMaxBytes)
      ? Math.max(0, config.toolPassthroughObservationMaxBytes)
      : 64 * 1024;
  }

  enableToolPassthroughObservation(maxBytes = this.toolPassthroughObservationMaxBytes) {
    this.toolPassthroughObservationOnly = true;
    this.toolPassthroughObservationMaxBytes = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : this.toolPassthroughObservationMaxBytes;
    for (const choice of this.choices.values()) {
      for (const tool of choice.toolCalls.values()) {
        const previousRetainedBytes = tool.argumentsRetainedBytes;
        const retained = utf8Prefix(tool.arguments, this.toolPassthroughObservationMaxBytes);
        const retainedBytes = Buffer.byteLength(retained, 'utf8');
        if (retainedBytes < previousRetainedBytes || tool.argumentBytes > retainedBytes) {
          tool.argumentsObservationTruncated = true;
        }
        tool.arguments = retained;
        tool.argumentsRetainedBytes = retainedBytes;
      }
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
      const toolDelta = absorbToolCalls(
        choice,
        delta.tool_calls,
        this.toolPassthroughObservationOnly ? this.toolPassthroughObservationMaxBytes : null,
      );
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
        ...collectToolDiagnostics(this.choices),
        ...collectCompletionDiagnostics({ done: this.done, choices: this.choices, usage: this.usage }),
      },
    };
  }

  finish() {
    for (const frame of this.decoder.finish()) this.#handle(frame);
    finalizeTools(this.choices);
    return this.snapshot();
  }
}

function malformedToolDiagnostics(choices, choiceIndex, toolIndex, tool) {
  const aggregate = collectToolDiagnostics(choices);
  return {
    ...aggregate,
    toolCallKey: `choice:${choiceIndex}/tool:${toolIndex}`,
    toolCallIndex: toolIndex,
    toolCallId: tool.id || null,
    toolName: tool.name || 'unknown',
    toolArgumentBytes: tool.argumentBytes || 0,
    toolArgumentFragments: tool.argumentFragmentCount || 0,
    ...tool.argumentErrorDiagnostics,
  };
}

function validateChoices(choices, config) {
  if (!(choices instanceof Map) || choices.size === 0) return invalid('missing_choices');
  let toolCount = 0;
  let hasOutput = false;
  for (const [choiceIndex, choice] of choices.entries()) {
    if (choice.content?.trim()) hasOutput = true;
    if (choice.toolCalls.size > 0) hasOutput = true;
    toolCount += choice.toolCalls.size;
    if (choice.toolCalls.size > 0 && choice.finishReason !== 'tool_calls') return invalid('tool_finish_reason_mismatch');
    for (const [toolIndex, tool] of choice.toolCalls.entries()) {
      if (!tool.name) return invalid('missing_tool_name');
      if (tool.argumentsObservationTruncated) continue;
      if (Buffer.byteLength(tool.arguments || '', 'utf8') > config.maxToolArgumentBytes) return invalid('tool_argument_limit', 'tool_argument_limit', { retryable: false, diagnostics: malformedToolDiagnostics(choices, choiceIndex, toolIndex, tool) });
      if (tool.argumentError) {
        return invalid('malformed_tool_arguments', tool.argumentError, {
          retryable: false,
          diagnostics: malformedToolDiagnostics(choices, choiceIndex, toolIndex, tool),
        });
      }
      if (!tool.parsedArguments || typeof tool.parsedArguments !== 'object' || Array.isArray(tool.parsedArguments)) {
        return invalid('invalid_tool_arguments', 'invalid_tool_arguments', {
          retryable: false,
          diagnostics: malformedToolDiagnostics(choices, choiceIndex, toolIndex, tool),
        });
      }
    }
  }
  if (toolCount > config.maxToolCalls) return invalid('too_many_tool_calls', 'too_many_tool_calls', { retryable: false, diagnostics: collectToolDiagnostics(choices) });
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
  createStreamParser(config) { return new ChatCompletionsStreamParser(config); },
  getReasoning(result) { return [...result.choices.values()].map((choice) => choice.reasoning).filter(Boolean); },
  shouldDetectReasoningLoop(_result, semantic) {
    return semantic.contentBytes === 0
      && semantic.toolCallCount === 0;
  },
  completionDiagnostics(result) { return collectCompletionDiagnostics(result); },
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
      ...collectToolDiagnostics(result.choices),
      ...collectCompletionDiagnostics(result),
    };
  },
  semanticProgress(result) { return this.semanticMetrics(result).semanticBytes; },
  validateIncremental(result, config) {
    if (result.error) return invalid('upstream_sse_error', result.error.message || 'upstream error');
    if (result.structuralErrors.length) return invalid(result.structuralErrors[0]);
    for (const [choiceIndex, choice] of result.choices.entries()) {
      if (Buffer.byteLength(choice.reasoning || '', 'utf8') > config.maxReasoningBytes) return invalid('reasoning_buffer_limit');
      for (const [toolIndex, tool] of choice.toolCalls.entries()) {
        if (Buffer.byteLength(tool.arguments || '', 'utf8') > config.maxToolArgumentBytes) {
          return invalid('tool_argument_limit', 'tool_argument_limit', {
            retryable: false,
            diagnostics: malformedToolDiagnostics(result.choices, choiceIndex, toolIndex, tool),
          });
        }
      }
    }
    return { ok: true };
  },
  validateStream(result, config) {
    if (!result.done) return withCompletionDiagnostics(result, invalid('missing_done'));
    if (result.error) return withCompletionDiagnostics(result, invalid('upstream_sse_error', result.error.message || 'upstream error'));
    if (result.structuralErrors.length) return withCompletionDiagnostics(result, invalid(result.structuralErrors[0]));
    return withCompletionDiagnostics(result, validateChoices(result.choices, config));
  },
  parseJson(buffer) {
    return normalizeNonStream(JSON.parse(buffer.toString('utf8')));
  },
  getJsonReasoning(result) { return [...result.choices.values()].map((choice) => choice.reasoning).filter(Boolean); },
  validateJson(result, config) {
    if (result.error) return withCompletionDiagnostics(result, invalid('upstream_json_error', result.error.message || 'upstream error'));
    return withCompletionDiagnostics(result, validateChoices(result.choices, config));
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
