import { looksLikeActionNarration } from '../core/action-narration.js';
import { isExplicitContinueInstruction } from '../core/execution-instruction.js';

function normalizeToolChoice(choice, toolCount) {
  if (choice === undefined || choice === null || choice === '') return toolCount > 0 ? 'auto' : 'none';
  if (typeof choice === 'string') return choice;
  if (choice && typeof choice === 'object') {
    const type = String(choice.type || 'object');
    return type === 'tool' && choice.name ? `tool:${choice.name}` : type;
  }
  return String(choice);
}


function anthropicContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => ['text', 'input_text'].includes(block?.type))
    .map((block) => block.text || '')
    .join('\n');
}

function latestAnthropicInput(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const hasToolResult = blocks.some((block) => block?.type === 'tool_result');
    const text = anthropicContentText(message.content).trim();
    if (message.role === 'user' && hasToolResult && !text) return { kind: 'tool_result', text: '' };
    return { kind: message.role === 'user' ? 'user' : (message.role || 'message'), text };
  }
  return { kind: 'none', text: '' };
}

export function summarizeAnthropicExecutionContext(body = {}) {
  const latest = latestAnthropicInput(body);
  return {
    latestInputKind: latest.kind,
    latestInputTextChars: latest.text.length,
    explicitContinueDetected: latest.kind === 'user' && isExplicitContinueInstruction(latest.text),
  };
}

export function summarizeAnthropicToolContext(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((tool) => String(tool?.name || '').trim()).filter(Boolean);
  const requestToolChoice = normalizeToolChoice(body.tool_choice, tools.length);
  return {
    requestToolCount: tools.length,
    requestToolNames: names,
    requestToolChoice,
    requestToolsEnabled: tools.length > 0 && requestToolChoice !== 'none',
    parallelToolCallsDisabled: Boolean(body.tool_choice?.disable_parallel_tool_use),
  };
}

export function detectAnthropicActionIntentWithoutToolCall({
  requestBody,
  output,
  completion,
  recovery = false,
} = {}) {
  if (!completion?.messageStopped || completion?.stopReason !== 'end_turn') return { ok: true };
  const toolContext = summarizeAnthropicToolContext(requestBody);
  if (!toolContext.requestToolsEnabled) return { ok: true };
  if (Array.isArray(output?.toolCalls) && output.toolCalls.length > 0) return { ok: true };
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  if (!finalText || !looksLikeActionNarration(finalText)) return { ok: true };

  return {
    ok: false,
    reason: 'action_intent_without_tool_call',
    detail: 'The response described an immediate action but ended without calling an available tool.',
    retryable: !recovery,
    diagnostics: {
      ...toolContext,
      actionIntentRecoveryAttempted: Boolean(recovery),
      finalTextChars: finalText.length,
      actionIntentDetected: true,
    },
  };
}

function appendSystem(system, instruction) {
  if (typeof system === 'string') return `${system}\n\n${instruction}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: instruction }];
  return instruction;
}

function capRecoverySampling(body, config) {
  const temperature = Number(body.temperature);
  body.temperature = Math.min(
    Number.isFinite(temperature) ? temperature : config.recoveryTemperatureMax,
    config.recoveryTemperatureMax,
  );
  const maxTokens = Number(body.max_tokens);
  body.max_tokens = Math.min(
    Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : config.recoveryMaxTokens,
    config.recoveryMaxTokens,
  );
}

function recoveryInstruction(issue) {
  const previousFailure = issue.reason === 'thinking_without_output'
    ? 'The previous response ended after reasoning without visible output or a tool call.'
    : 'The previous response described an immediate action but ended without a tool call.';
  return [
    'Recovery is expected and the original task remains solvable.',
    previousFailure,
    'The previous generation was discarded and did not change task or tool state.',
    'Continue from the original request and accepted prior tool results only.',
    'Do not repeat the plan, announce the next action, or explain the recovery.',
    'Produce at least one tool call now and no narration-only final response.',
    'Choose the appropriate tool from the tools supplied in this request.',
    `Recovery reason: ${issue.reason}.`,
  ].join(' ');
}

function outputRecoveryInstruction(issue) {
  return [
    'Recovery is expected and the original task remains solvable.',
    'The previous response ended after reasoning without visible output or a tool call.',
    'The previous generation was discarded and did not change task or tool state.',
    'Continue from the original request and accepted prior tool results only.',
    'Do not explain the recovery or repeat hidden reasoning.',
    'Produce one valid user-visible response now.',
    'Use a supplied tool only when the task actually requires external action; otherwise answer, explain, plan, report completion, wait for confirmation, or ask one genuinely blocking question.',
    'Do not end the turn with reasoning only.',
    `Recovery reason: ${issue.reason}.`,
  ].join(' ');
}

export function buildAnthropicOutputRequiredRecovery({ original, prepared = null, issue, config }) {
  if (!issue || issue.ok !== false || issue.reason !== 'thinking_without_output') {
    throw new TypeError('An Anthropic output-required recovery issue is required');
  }

  const body = structuredClone(prepared || original);
  capRecoverySampling(body, config);
  body.system = appendSystem(body.system, outputRecoveryInstruction(issue));

  const toolContext = summarizeAnthropicToolContext(body);
  const plan = {
    mode: 'output_required',
    originReason: issue.reason,
    candidateNames: [...toolContext.requestToolNames],
  };
  return {
    body,
    plan,
    diagnostics: {
      recoveryInstructionPlacement: 'system',
      recoveryMode: plan.mode,
      recoveryOriginReason: plan.originReason,
      recoveryToolCount: toolContext.requestToolCount,
      recoveryToolNames: [...plan.candidateNames],
      recoveryToolChoice: toolContext.requestToolChoice,
      forcedToolChoice: false,
      parallelToolCallsDisabled: toolContext.parallelToolCallsDisabled,
    },
  };
}

export function validateAnthropicOutputRequiredRecovery(output, plan) {
  if (plan?.mode !== 'output_required') return { ok: true };
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  if (calls.length > 0 || finalText) return { ok: true };
  return {
    ok: false,
    reason: plan.originReason || 'thinking_without_output',
    detail: 'The output-required Recovery ended without visible output or a Tool Call.',
    retryable: false,
    diagnostics: {
      requestToolCount: Array.isArray(plan.candidateNames) ? plan.candidateNames.length : 0,
      requestToolNames: Array.isArray(plan.candidateNames) ? [...plan.candidateNames] : [],
      outputRecoveryAttempted: true,
      finalTextChars: 0,
    },
  };
}

export function buildAnthropicActionRequiredRecovery({ original, prepared = null, issue, config }) {
  if (!issue || issue.ok !== false || !['action_intent_without_tool_call', 'thinking_without_output'].includes(issue.reason)) {
    throw new TypeError('An Anthropic action-required recovery issue is required');
  }
  const toolContext = summarizeAnthropicToolContext(original);
  if (!toolContext.requestToolsEnabled) throw new Error('Action-required Recovery requires enabled tools');

  const body = structuredClone(prepared || original);
  capRecoverySampling(body, config);
  body.tools = structuredClone(original.tools);
  body.tool_choice = { type: 'any', disable_parallel_tool_use: true };
  body.system = appendSystem(body.system, recoveryInstruction(issue));

  const plan = {
    mode: 'action_required',
    originReason: issue.reason,
    candidateNames: [...toolContext.requestToolNames],
  };
  return {
    body,
    plan,
    diagnostics: {
      recoveryInstructionPlacement: 'system',
      recoveryMode: plan.mode,
      recoveryOriginReason: plan.originReason,
      recoveryToolCount: body.tools.length,
      recoveryToolNames: [...plan.candidateNames],
      forcedToolChoice: 'any',
      parallelToolCallsDisabled: true,
    },
  };
}

export function validateAnthropicActionRequiredRecovery(output, plan) {
  if (plan?.mode !== 'action_required') return { ok: true };
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (calls.length > 0) return { ok: true };
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  return {
    ok: false,
    reason: plan.originReason || 'action_intent_without_tool_call',
    detail: 'The action-required Recovery ended without a Tool Call.',
    retryable: false,
    diagnostics: {
      requestToolCount: Array.isArray(plan.candidateNames) ? plan.candidateNames.length : 0,
      requestToolNames: Array.isArray(plan.candidateNames) ? [...plan.candidateNames] : [],
      actionIntentRecoveryAttempted: true,
      actionIntentDetected: looksLikeActionNarration(finalText),
      finalTextChars: finalText.length,
    },
  };
}
