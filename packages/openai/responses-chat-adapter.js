import { randomUUID } from 'node:crypto';
import { SseFrameDecoder, encodeSseData } from '../core/sse.js';

export class ResponsesChatAdapterError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'ResponsesChatAdapterError';
    this.code = code;
    this.details = details;
  }
}


export function normalizeResponsesRequestForChatAdapter(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ResponsesChatAdapterError('invalid_responses_request');
  }
  const normalized = structuredClone(body);
  if (!Array.isArray(normalized.input)) return normalized;

  const retainedInput = [];
  const additionalTools = [];
  for (const item of normalized.input) {
    if (item?.type !== 'additional_tools') {
      retainedInput.push(item);
      continue;
    }
    if (!Array.isArray(item.tools)) {
      throw new ResponsesChatAdapterError('invalid_additional_tools');
    }
    additionalTools.push(...item.tools);
  }
  if (additionalTools.length > 0) {
    normalized.tools = [...(Array.isArray(normalized.tools) ? normalized.tools : []), ...additionalTools];
  }
  normalized.input = retainedInput;
  return normalized;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (!Array.isArray(value)) throw new ResponsesChatAdapterError('unsupported_responses_content');
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.refusal === 'string') return part.refusal;
    if (typeof part?.output_text === 'string') return part.output_text;
    throw new ResponsesChatAdapterError('unsupported_responses_content_item', `unsupported_responses_content_item:${part?.type || 'unknown'}`);
  }).join('');
}

function messageContentOf(value, role) {
  if (typeof value === 'string' || value === null || value === undefined) return textOf(value);
  if (!Array.isArray(value)) throw new ResponsesChatAdapterError('unsupported_responses_content');

  const parts = [];
  let hasMedia = false;
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (typeof part?.text === 'string' || typeof part?.output_text === 'string' || typeof part?.refusal === 'string') {
      parts.push({ type: 'text', text: part.text ?? part.output_text ?? part.refusal });
      continue;
    }
    if (part?.type === 'input_image' && role === 'user') {
      const url = part.image_url || part.url;
      if (typeof url !== 'string' || !url) throw new ResponsesChatAdapterError('invalid_input_image');
      parts.push({
        type: 'image_url',
        image_url: { url, ...(part.detail !== undefined ? { detail: part.detail } : {}) },
      });
      hasMedia = true;
      continue;
    }
    throw new ResponsesChatAdapterError('unsupported_responses_content_item', `unsupported_responses_content_item:${part?.type || 'unknown'}`);
  }
  if (hasMedia) return parts;
  return parts.map((part) => part.text).join('');
}

function outputOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function flattenNamespaceName(namespace, name) {
  if (!namespace) return name;
  return namespace.endsWith('__') ? `${namespace}${name}` : `${namespace}__${name}`;
}

function appendAssistantToolCall(messages, item) {
  let message = messages.at(-1);
  if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.content !== null) {
    message = { role: 'assistant', content: null, tool_calls: [] };
    messages.push(message);
  }
  const callId = item.call_id || item.id;
  if (!callId || !item.name) throw new ResponsesChatAdapterError('invalid_function_call_history');
  const argumentsText = item.type === 'custom_tool_call'
    ? JSON.stringify({ __arg1: typeof item.input === 'string' ? item.input : outputOf(item.input) })
    : (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}));
  message.tool_calls.push({
    id: callId,
    type: 'function',
    function: { name: flattenNamespaceName(item.namespace, item.name), arguments: argumentsText },
  });
}

function convertInput(input, systemParts) {
  const messages = [];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (input === null || input === undefined) return messages;
  if (!Array.isArray(input)) throw new ResponsesChatAdapterError('unsupported_responses_input');

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning' || item.type === 'item_reference') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      appendAssistantToolCall(messages, item);
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!item.call_id) throw new ResponsesChatAdapterError('invalid_function_call_output');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: outputOf(item.output) });
      continue;
    }
    if (item.type === 'message' || item.role) {
      const role = item.role || 'user';
      if (role === 'developer' || role === 'system') {
        const content = textOf(item.content);
        if (content) systemParts.push(content);
      } else if (role === 'user' || role === 'assistant' || role === 'tool') {
        if (role === 'tool') {
          const callId = item.tool_call_id || item.call_id;
          if (!callId) throw new ResponsesChatAdapterError('invalid_function_call_output');
          messages.push({ role: 'tool', tool_call_id: callId, content: textOf(item.content) });
        } else {
          messages.push({ role, content: messageContentOf(item.content, role) });
        }
      }
      continue;
    }
    throw new ResponsesChatAdapterError('unsupported_responses_input_item', `unsupported_responses_input_item:${item.type || 'unknown'}`);
  }
  return messages;
}

function convertTool(tool) {
  if (tool?.type === 'namespace') {
    if (!tool.name || !Array.isArray(tool.tools)) throw new ResponsesChatAdapterError('invalid_namespace_tool');
    return tool.tools.map((entry) => ({
      type: 'function',
      function: {
        name: flattenNamespaceName(tool.name, entry.name),
        ...(entry.description !== undefined ? { description: `${tool.description ? `${tool.description}\n\n` : ''}${entry.description}` } : (tool.description ? { description: tool.description } : {})),
        parameters: entry.parameters || { type: 'object', properties: {} },
        ...(entry.strict !== undefined ? { strict: entry.strict } : {}),
      },
    }));
  }
  if (tool?.type === 'custom') {
    if (!tool.name) throw new ResponsesChatAdapterError('invalid_custom_tool');
    return [{
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: {
          type: 'object',
          properties: { __arg1: { type: 'string', description: 'Freeform input for the custom tool.' } },
          required: ['__arg1'],
          additionalProperties: false,
        },
        strict: false,
      },
    }];
  }
  if (tool?.type !== 'function') throw new ResponsesChatAdapterError('unsupported_responses_tool', `unsupported_responses_tool:${tool?.type || 'unknown'}`);
  const source = tool.function || tool;
  if (!source.name) throw new ResponsesChatAdapterError('invalid_function_tool');
  return [{
    type: 'function',
    function: {
      name: source.name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      parameters: source.parameters || { type: 'object', properties: {} },
      ...(source.strict !== undefined ? { strict: source.strict } : {}),
    },
  }];
}

function convertToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function') {
    const name = choice.name || choice.function?.name;
    if (!name) throw new ResponsesChatAdapterError('invalid_tool_choice');
    return { type: 'function', function: { name } };
  }
  throw new ResponsesChatAdapterError('unsupported_tool_choice');
}

function convertTextFormat(text) {
  const format = text?.format;
  if (!format) return undefined;
  if (format.type === 'text') return { type: 'text' };
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name || 'response',
        schema: format.schema || {},
        ...(format.description !== undefined ? { description: format.description } : {}),
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  throw new ResponsesChatAdapterError('unsupported_text_format');
}

export function convertResponsesRequestToChat(body) {
  body = normalizeResponsesRequestForChatAdapter(body);
  if (body.previous_response_id) throw new ResponsesChatAdapterError('unsupported_previous_response_id');
  if (body.background) throw new ResponsesChatAdapterError('unsupported_background_mode');
  if (body.store === true) throw new ResponsesChatAdapterError('unsupported_response_storage');

  const systemParts = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) systemParts.push(body.instructions);
  const messages = convertInput(body.input, systemParts);
  if (systemParts.length > 0) messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
  if (messages.length === 0) throw new ResponsesChatAdapterError('missing_responses_input');

  const result = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
  };
  if (result.stream) result.stream_options = { include_usage: true };
  if (Array.isArray(body.tools)) result.tools = body.tools.flatMap(convertTool);
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = Boolean(body.parallel_tool_calls);
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  for (const key of ['temperature', 'top_p', 'seed']) if (body[key] !== undefined) result[key] = body[key];
  if (body.reasoning?.effort !== undefined) result.reasoning_effort = body.reasoning.effort;
  const responseFormat = convertTextFormat(body.text);
  if (responseFormat) result.response_format = responseFormat;
  return result;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const input = Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : 0;
  const output = Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : 0;
  const total = Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

function contextDefaults(context = {}, payload = {}) {
  return {
    responseId: context.responseId || `resp_${randomUUID().replaceAll('-', '')}`,
    model: context.model ?? payload.model ?? null,
    createdAt: context.createdAt ?? payload.created ?? Math.floor(Date.now() / 1000),
    toolKinds: context.toolKinds instanceof Map ? context.toolKinds : new Map(),
    instructions: context.instructions ?? null,
    maxOutputTokens: context.maxOutputTokens ?? null,
    parallelToolCalls: context.parallelToolCalls ?? true,
    toolChoice: context.toolChoice ?? 'auto',
    tools: Array.isArray(context.tools) ? structuredClone(context.tools) : [],
  };
}

function toolKindsFromRequest(body = {}) {
  const kinds = new Map();
  for (const tool of body.tools || []) {
    if (tool?.type === 'namespace' && tool.name && Array.isArray(tool.tools)) {
      for (const entry of tool.tools) {
        if (!entry?.name) continue;
        kinds.set(flattenNamespaceName(tool.name, entry.name), { type: 'function', namespace: tool.name, originalName: entry.name });
      }
      continue;
    }
    const name = tool?.name || tool?.function?.name;
    if (name) kinds.set(name, { type: tool.type || 'function', namespace: tool.namespace || null, originalName: name });
  }
  return kinds;
}

function customInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText || '{}');
    if (typeof parsed?.__arg1 === 'string') return parsed.__arg1;
    if (typeof parsed?.input === 'string') return parsed.input;
  } catch { /* preserve raw text below */ }
  return String(argumentsText || '');
}

function reasoningText(message = {}) {
  if (typeof message.reasoning_content === 'string') return message.reasoning_content;
  if (typeof message.reasoning === 'string') return message.reasoning;
  return '';
}

function responseBase(context, status, output, usage, incompleteDetails = null) {
  return {
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    status,
    error: null,
    incomplete_details: incompleteDetails,
    instructions: context.instructions,
    max_output_tokens: context.maxOutputTokens,
    model: context.model,
    output,
    parallel_tool_calls: context.parallelToolCalls,
    tool_choice: context.toolChoice,
    tools: context.tools,
    usage,
  };
}

export function convertChatJsonToResponses(payload, rawContext = {}) {
  const context = contextDefaults(rawContext, payload);
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const reasoning = reasoningText(message);
  if (reasoning) output.push({ id: `rs_${context.responseId}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: reasoning }] });
  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({ id: `msg_${context.responseId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  }
  for (const [index, tool] of (message.tool_calls || []).entries()) {
    const name = tool.function?.name || '';
    const argumentsText = tool.function?.arguments || '';
    const metadata = context.toolKinds.get(name) || {};
    const kind = metadata.type || 'function';
    const outputName = metadata.originalName || name;
    if (kind === 'custom') {
      output.push({
        id: `ct_${context.responseId}_${index}`,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: tool.id || `call_${context.responseId}_${index}`,
        name: outputName,
        input: customInput(argumentsText),
      });
    } else {
      output.push({
        id: `fc_${context.responseId}_${index}`,
        type: 'function_call',
        status: 'completed',
        call_id: tool.id || `call_${context.responseId}_${index}`,
        name: outputName,
        arguments: argumentsText,
        ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
      });
    }
  }
  const incomplete = choice.finish_reason === 'length';
  return responseBase(context, incomplete ? 'incomplete' : 'completed', output, normalizeUsage(payload?.usage), incomplete ? { reason: 'max_output_tokens' } : null);
}

class ChatToResponsesStreamEncoder {
  constructor(context) {
    this.context = contextDefaults(context);
    this.sequence = 0;
    this.output = [];
    this.reasoning = '';
    this.content = '';
    this.reasoningStarted = false;
    this.messageStarted = false;
    this.tools = new Map();
    this.finishReason = null;
    this.usage = null;
    this.finalized = false;
    this.nextOutputIndex = 0;
    this.reasoningIndex = null;
    this.messageIndex = null;
  }

  #event(type, payload = {}) {
    return encodeSseData({ type, sequence_number: this.sequence++, ...payload }, type);
  }

  start() {
    const response = responseBase(this.context, 'in_progress', [], null);
    return this.#event('response.created', { response }) + this.#event('response.in_progress', { response });
  }

  #startReasoning() {
    if (this.reasoningStarted) return '';
    this.reasoningStarted = true;
    this.reasoningIndex = this.nextOutputIndex++;
    const item = { id: `rs_${this.context.responseId}`, type: 'reasoning', status: 'in_progress', summary: [] };
    return this.#event('response.output_item.added', { output_index: this.reasoningIndex, item })
      + this.#event('response.reasoning_summary_part.added', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
  }

  #startMessage() {
    if (this.messageStarted) return '';
    this.messageStarted = true;
    this.messageIndex = this.nextOutputIndex++;
    const outputIndex = this.messageIndex;
    const item = { id: `msg_${this.context.responseId}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    return this.#event('response.output_item.added', { output_index: outputIndex, item })
      + this.#event('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  }

  #toolOutputIndex(tool) {
    if (!Number.isInteger(tool.outputIndex)) tool.outputIndex = this.nextOutputIndex++;
    return tool.outputIndex;
  }

  push(payload) {
    let output = '';
    if (payload?.usage) this.usage = normalizeUsage(payload.usage);
    for (const choice of payload?.choices || []) {
      const delta = choice.delta || {};
      const reasoning = reasoningText(delta);
      if (reasoning) {
        output += this.#startReasoning();
        this.reasoning += reasoning;
        output += this.#event('response.reasoning_summary_text.delta', { item_id: `rs_${this.context.responseId}`, output_index: this.reasoningIndex, summary_index: 0, delta: reasoning });
      }
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content) {
        output += this.#startMessage();
        this.content += content;
        const outputIndex = this.messageIndex;
        output += this.#event('response.output_text.delta', { item_id: `msg_${this.context.responseId}`, output_index: outputIndex, content_index: 0, delta: content, logprobs: [] });
      }
      for (const [position, fragment] of (delta.tool_calls || []).entries()) {
        const index = Number.isInteger(fragment.index) ? fragment.index : position;
        let tool = this.tools.get(index);
        if (!tool) {
          tool = { index, itemId: `fc_${this.context.responseId}_${index}`, callId: fragment.id || `call_${this.context.responseId}_${index}`, name: '', outputName: '', namespace: null, arguments: '', started: false, outputIndex: null, kind: 'function' };
          this.tools.set(index, tool);
        }
        if (fragment.id) tool.callId = fragment.id;
        if (typeof fragment.function?.name === 'string') tool.name += fragment.function.name;
        const metadata = this.context.toolKinds.get(tool.name) || {};
        tool.kind = metadata.type || tool.kind;
        tool.outputName = metadata.originalName || tool.name;
        tool.namespace = metadata.namespace || null;
        if (tool.kind === 'custom') tool.itemId = `ct_${this.context.responseId}_${index}`;
        const argumentDelta = typeof fragment.function?.arguments === 'string' ? fragment.function.arguments : '';
        if (!tool.started && (tool.name || argumentDelta || fragment.id)) {
          tool.started = true;
          const outputIndex = this.#toolOutputIndex(tool);
          output += this.#event('response.output_item.added', {
            output_index: outputIndex,
            item: tool.kind === 'custom'
              ? { id: tool.itemId, type: 'custom_tool_call', status: 'in_progress', call_id: tool.callId, name: tool.outputName || tool.name, input: '' }
              : { id: tool.itemId, type: 'function_call', status: 'in_progress', call_id: tool.callId, name: tool.outputName || tool.name, arguments: '', ...(tool.namespace ? { namespace: tool.namespace } : {}) },
          });
        }
        if (argumentDelta) {
          tool.arguments += argumentDelta;
          if (tool.kind !== 'custom') output += this.#event('response.function_call_arguments.delta', { item_id: tool.itemId, output_index: this.#toolOutputIndex(tool), delta: argumentDelta });
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.finishReason = choice.finish_reason;
    }
    return output;
  }

  finish() {
    if (this.finalized) return '';
    this.finalized = true;
    let output = '';
    const finalItems = [];
    if (this.reasoningStarted) {
      const item = { id: `rs_${this.context.responseId}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: this.reasoning }] };
      output += this.#event('response.reasoning_summary_text.done', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, text: this.reasoning });
      output += this.#event('response.reasoning_summary_part.done', { item_id: item.id, output_index: this.reasoningIndex, summary_index: 0, part: item.summary[0] });
      output += this.#event('response.output_item.done', { output_index: this.reasoningIndex, item });
      finalItems.push(item);
    }
    if (this.messageStarted) {
      const outputIndex = this.messageIndex;
      const item = { id: `msg_${this.context.responseId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: this.content, annotations: [] }] };
      output += this.#event('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: this.content, logprobs: [] });
      output += this.#event('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0] });
      output += this.#event('response.output_item.done', { output_index: outputIndex, item });
      finalItems.push(item);
    }
    for (const [, tool] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      const outputIndex = this.#toolOutputIndex(tool);
      if (tool.kind === 'custom') {
        const input = customInput(tool.arguments);
        const item = { id: tool.itemId, type: 'custom_tool_call', status: 'completed', call_id: tool.callId, name: tool.outputName || tool.name, input };
        if (!tool.started) {
          output += this.#event('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', input: '' } });
        }
        output += this.#event('response.custom_tool_call_input.done', { item_id: tool.itemId, output_index: outputIndex, input });
        output += this.#event('response.output_item.done', { output_index: outputIndex, item });
        finalItems.push(item);
      } else {
        const item = { id: tool.itemId, type: 'function_call', status: 'completed', call_id: tool.callId, name: tool.outputName || tool.name, arguments: tool.arguments, ...(tool.namespace ? { namespace: tool.namespace } : {}) };
        output += this.#event('response.function_call_arguments.done', { item_id: tool.itemId, output_index: outputIndex, name: tool.outputName || tool.name, arguments: tool.arguments });
        output += this.#event('response.output_item.done', { output_index: outputIndex, item });
        finalItems.push(item);
      }
    }
    const incomplete = this.finishReason === 'length';
    const response = responseBase(this.context, incomplete ? 'incomplete' : 'completed', finalItems, this.usage, incomplete ? { reason: 'max_output_tokens' } : null);
    output += this.#event(incomplete ? 'response.incomplete' : 'response.completed', { response });
    return output;
  }
}

function copyHeaders(headers, contentType) {
  const output = new Headers(headers);
  output.delete('content-length');
  output.delete('content-encoding');
  output.set('content-type', contentType);
  output.set('x-vllm-proxy-responses-upstream-mode', 'chat_adapter');
  return output;
}

function chatTargetUrl(url) {
  const target = new URL(url);
  target.pathname = '/v1/chat/completions';
  return target.toString();
}

function transformChatStream(response, context) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new SseFrameDecoder();
  const encoder = new ChatToResponsesStreamEncoder(context);
  const textEncoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(textEncoder.encode(encoder.start()));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of decoder.push(value)) {
            if (frame.incomplete) throw new Error('incomplete_chat_sse_frame');
            if (frame.data === '[DONE]') continue;
            let payload;
            try { payload = JSON.parse(frame.data); } catch { throw new Error('invalid_chat_sse_json'); }
            if (payload?.error) {
              controller.enqueue(textEncoder.encode(encodeSseData({ type: 'error', error: payload.error }, 'error')));
              controller.close();
              return;
            }
            const rendered = encoder.push(payload);
            if (rendered) controller.enqueue(textEncoder.encode(rendered));
          }
        }
        for (const frame of decoder.finish()) {
          if (frame.incomplete) throw new Error('incomplete_chat_sse_frame');
          if (frame.data !== '[DONE]') {
            const rendered = encoder.push(JSON.parse(frame.data));
            if (rendered) controller.enqueue(textEncoder.encode(rendered));
          }
        }
        controller.enqueue(textEncoder.encode(encoder.finish()));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: copyHeaders(response.headers, 'text/event-stream; charset=utf-8') });
}

export function createResponsesChatAdapterFetch(fetchImpl = globalThis.fetch) {
  return async function responsesChatAdapterFetch(url, init = {}) {
    const rawBody = typeof init.body === 'string' ? init.body : Buffer.from(init.body || '').toString('utf8');
    const responsesBody = normalizeResponsesRequestForChatAdapter(JSON.parse(rawBody || '{}'));
    const chatBody = convertResponsesRequestToChat(responsesBody);
    const context = contextDefaults({
      model: responsesBody.model,
      toolKinds: toolKindsFromRequest(responsesBody),
      instructions: responsesBody.instructions ?? null,
      maxOutputTokens: responsesBody.max_output_tokens ?? null,
      parallelToolCalls: responsesBody.parallel_tool_calls ?? true,
      toolChoice: responsesBody.tool_choice ?? 'auto',
      tools: responsesBody.tools || [],
    });
    const upstream = await fetchImpl(chatTargetUrl(url), { ...init, body: JSON.stringify(chatBody) });
    if (!upstream.ok) return upstream;
    if (chatBody.stream) return transformChatStream(upstream, context);
    const payload = await upstream.json();
    const responsePayload = convertChatJsonToResponses(payload, context);
    return new Response(JSON.stringify(responsePayload), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyHeaders(upstream.headers, 'application/json; charset=utf-8'),
    });
  };
}
