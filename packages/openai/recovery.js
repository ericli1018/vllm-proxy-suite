import { toolName } from './tool-classifier.js';

export function inspectChatSystemMessages(messages) {
  const indexes = [];
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    if (message?.role === 'system') indexes.push(index);
  }
  return {
    count: indexes.length,
    indexes,
    valid: indexes.length === 0 || (indexes.length === 1 && indexes[0] === 0),
  };
}

export function validateChatMessageOrdering(messages) {
  const inspection = inspectChatSystemMessages(messages);
  if (inspection.valid) return { ok: true };
  const messageIndex = inspection.indexes.find((index) => index !== 0) ?? inspection.indexes[1] ?? inspection.indexes[0];
  return {
    ok: false,
    code: 'system_message_not_first',
    message: 'System messages are only permitted at messages[0].',
    messageIndex,
    systemMessageIndexes: inspection.indexes,
  };
}

export function assertChatMessageOrdering(messages) {
  const validation = validateChatMessageOrdering(messages);
  if (validation.ok) return;
  const error = new Error(validation.message);
  error.code = validation.code;
  error.details = {
    message_index: validation.messageIndex,
    system_message_indexes: validation.systemMessageIndexes,
  };
  throw error;
}

function appendTextContent(content, text) {
  if (typeof content === 'string') return content ? `${content}\n\n${text}` : text;
  if (Array.isArray(content)) return [...content, { type: 'text', text }];
  return text;
}

function appendInstruction(body, api, text) {
  if (api === 'responses') {
    body.instructions = body.instructions ? `${body.instructions}\n\n${text}` : text;
    return 'instructions';
  }

  if (!Array.isArray(body.messages)) body.messages = [];
  assertChatMessageOrdering(body.messages);
  if (body.messages[0]?.role === 'system') {
    body.messages[0].content = appendTextContent(body.messages[0].content, text);
    assertChatMessageOrdering(body.messages);
    return 'merged_leading_system';
  }

  body.messages.unshift({ role: 'system', content: text });
  assertChatMessageOrdering(body.messages);
  return 'inserted_leading_system';
}

function actionRequiredInstruction(reason) {
  return [
    'The previous response completed without calling any tool after describing future actions.',
    'Do not repeat the plan or a progress announcement.',
    'Call exactly one appropriate available tool now to begin execution.',
    'Do not return text before the tool call.',
    'Wait for the tool result before continuing.',
    `Recovery reason: ${reason}.`,
  ].join(' ');
}

function recoveryInstruction(reason, plan) {
  if (plan?.mode === 'action_required') return actionRequiredInstruction(reason);
  const network = typeof plan?.mode === 'string' && plan.mode.startsWith('network_')
    ? `Use exactly one available ${plan.mode.replace('network_', '')} tool to create new external evidence.`
    : 'Use an available evidence-producing action or provide a final answer from already accepted evidence.';
  return [
    'The previous generation entered a repetitive or incomplete reasoning cycle.',
    'The failed attempt is not task progress and none of its reasoning, text, or tool calls may be reused as verified state.',
    'Continue from the original request and accepted prior tool results only.',
    'Do not repeat the same hypothesis without new evidence.',
    network,
    `Recovery reason: ${reason}.`,
  ].join(' ');
}

function capNumber(value, cap, fallback = cap) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(number, cap) : fallback;
}

export function buildOpenAiRecoveryRequest(original, { api, reason, plan, config }) {
  const body = structuredClone(original);
  const network = typeof plan?.mode === 'string' && plan.mode.startsWith('network_');
  const actionRequired = plan?.mode === 'action_required';
  const temperatureCap = network ? config.recoveryNetworkTemperatureMax : config.recoveryTemperatureMax;
  const tokenCap = network ? config.recoveryNetworkMaxTokens : config.recoveryMaxTokens;
  body.temperature = capNumber(body.temperature, temperatureCap);
  if (api === 'responses') {
    body.max_output_tokens = capNumber(body.max_output_tokens, tokenCap);
  } else if ('max_completion_tokens' in body) {
    body.max_completion_tokens = capNumber(body.max_completion_tokens, tokenCap);
  } else {
    body.max_tokens = capNumber(body.max_tokens, tokenCap);
  }
  appendInstruction(body, api, recoveryInstruction(reason, plan));

  if (actionRequired) {
    body.tool_choice = 'required';
    body.parallel_tool_calls = false;
  } else if (network) {
    const allowed = new Set(plan.candidateNames);
    body.tools = (body.tools || []).filter((tool) => allowed.has(toolName(tool)));
    if (plan.candidateNames.length === 1) {
      body.tool_choice = api === 'responses'
        ? { type: 'function', name: plan.candidateNames[0] }
        : { type: 'function', function: { name: plan.candidateNames[0] } };
    } else {
      body.tool_choice = 'required';
    }
    body.parallel_tool_calls = false;
  }
  return body;
}

export function validateForcedToolRecovery(output, plan) {
  if (!plan || plan.mode === 'none') return { ok: true };
  if (plan.mode === 'action_required' && (output.finalText?.trim() || output.toolCalls.length !== 1)) {
    return {
      ok: false,
      reason: 'actionless_completion',
      retryable: false,
      diagnostics: {
        actionlessRecoveryAttempted: true,
        recoveryToolCallCount: output.toolCalls.length,
        recoveryFinalTextChars: output.finalText?.trim()?.length || 0,
      },
    };
  }
  if (output.finalText?.trim() || output.toolCalls.length !== 1) return { ok: false, reason: 'forced_tool_call_required' };
  const tool = output.toolCalls[0];
  if (!plan.candidateNames.includes(tool.name)) return { ok: false, reason: 'unexpected_recovery_tool' };
  if (!tool.parsedArguments || typeof tool.parsedArguments !== 'object' || Array.isArray(tool.parsedArguments)) return { ok: false, reason: 'invalid_recovery_tool_arguments' };
  return { ok: true };
}
