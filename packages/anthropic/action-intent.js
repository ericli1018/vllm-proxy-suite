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

const ANTHROPIC_PLACEHOLDER_COMPLETIONS = new Set([
  'no response',
  'no output',
  '無回應',
  '沒有回應',
  '無輸出',
  '沒有輸出',
]);

function normalizePlaceholderCompletionText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^[`*_~"'“”‘’<>\[\](){}]+|[`*_~"'“”‘’<>\[\](){}]+$/gu, '')
    .trim()
    .replace(/[.!！。?？:：;；]+$/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function isAnthropicPlaceholderCompletionText(value) {
  return ANTHROPIC_PLACEHOLDER_COMPLETIONS.has(normalizePlaceholderCompletionText(value));
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

export function detectAnthropicPlaceholderCompletionWithoutProgress({
  requestBody,
  output,
  completion,
  recovery = false,
} = {}) {
  if (!completion?.messageStopped || completion?.stopReason !== 'end_turn') return { ok: true };
  if (Array.isArray(output?.toolCalls) && output.toolCalls.length > 0) return { ok: true };
  const execution = summarizeAnthropicExecutionContext(requestBody);
  if (execution.latestInputKind !== 'tool_result') return { ok: true };
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  if (!finalText || !isAnthropicPlaceholderCompletionText(finalText)) return { ok: true };

  return {
    ok: false,
    reason: 'placeholder_completion_without_progress',
    detail: 'The response contained only a placeholder after a Tool Result and ended without substantive output or another Tool Call.',
    retryable: !recovery,
    diagnostics: {
      latestInputKind: execution.latestInputKind,
      placeholderCompletionDetected: true,
      placeholderText: normalizePlaceholderCompletionText(finalText),
      finalTextChars: finalText.length,
      placeholderRecoveryAttempted: Boolean(recovery),
    },
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

function applyRecoveryThinkingPolicy(body, disabled) {
  if (disabled === false) return false;
  const existing = body.chat_template_kwargs && typeof body.chat_template_kwargs === 'object' && !Array.isArray(body.chat_template_kwargs)
    ? structuredClone(body.chat_template_kwargs)
    : {};
  delete body.thinking;
  body.think = false;
  body.chat_template_kwargs = { ...existing, enable_thinking: false };
  return true;
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
  const placeholderCompletion = issue.reason === 'placeholder_completion_without_progress';
  const schemaInvalidToolInput = issue.reason === 'invalid_tool_input_schema';
  const targetlessToolInput = issue.reason === 'invalid_claude_code_tool_input'
    && issue.diagnostics?.targetlessToolRecovery === true
    && !issue.context?.targetPath;

  let previousFailure = 'The previous response ended after reasoning without visible output or a tool call.';
  if (schemaInvalidToolInput) {
    previousFailure = 'The previous tool call was rejected because required input fields were missing or its input did not match the supplied tool schema.';
  } else if (targetlessToolInput) {
    previousFailure = 'The previous tool call had incomplete or invalid input and was discarded.';
  } else if (placeholderCompletion) {
    previousFailure = 'The previous response contained only a placeholder after the latest accepted Tool Result.';
  }

  const recoveryConstraint = schemaInvalidToolInput
    ? 'Do not invent missing identifiers or arguments. Use an appropriate read or list tool first when current state is required. Do not repeat the rejected tool input unchanged.'
    : (targetlessToolInput
      ? 'Do not assume the rejected tool must be used. Do not repeat an empty or incomplete tool call.'
      : (placeholderCompletion
        ? 'Do not answer with “No response”, “No output”, “無回應”, “沒有回應”, “無輸出”, “沒有輸出”, or another placeholder.'
        : 'Do not end the turn with reasoning only.'));

  return [
    'Recovery is expected and the original task remains solvable.',
    previousFailure,
    'The previous generation was discarded and did not change task or tool state.',
    'Continue from the original request and accepted prior tool results only.',
    'Do not explain the recovery or repeat hidden reasoning.',
    (targetlessToolInput || schemaInvalidToolInput)
      ? 'Produce one substantive user-visible response, one complete valid tool call if external action is required, or one genuinely blocking question.'
      : 'Produce one valid user-visible response now.',
    'Use a supplied tool only when the task actually requires external action; otherwise answer, explain, plan, report completion, wait for confirmation, or ask one genuinely blocking question.',
    recoveryConstraint,
    `Recovery reason: ${issue.reason}.`,
  ].join(' ');
}

export function buildAnthropicOutputRequiredRecovery({ original, prepared = null, issue, config }) {
  const supportedReasons = ['thinking_without_output', 'placeholder_completion_without_progress', 'invalid_claude_code_tool_input', 'invalid_tool_input_schema'];
  const targetlessToolInput = issue?.reason === 'invalid_claude_code_tool_input'
    && issue?.diagnostics?.targetlessToolRecovery === true
    && issue?.context
    && !issue.context.targetPath;
  if (!issue || issue.ok !== false || !supportedReasons.includes(issue.reason) || (issue.reason === 'invalid_claude_code_tool_input' && !targetlessToolInput)) {
    throw new TypeError('An Anthropic output-required recovery issue is required');
  }

  const body = structuredClone(prepared || original);
  capRecoverySampling(body, config);
  const recoveryThinkingDisabled = applyRecoveryThinkingPolicy(
    body,
    config?.outputRequiredRecoveryDisableThinking,
  );
  body.system = appendSystem(body.system, outputRecoveryInstruction(issue));

  const toolContext = summarizeAnthropicToolContext(body);
  const plan = {
    mode: 'output_required',
    originReason: issue.reason,
    candidateNames: [...toolContext.requestToolNames],
    rejectPlaceholderCompletion: issue.reason === 'placeholder_completion_without_progress',
    targetlessToolRecovery: targetlessToolInput,
    toolInputSchemaRecovery: issue.reason === 'invalid_tool_input_schema',
    ...(['invalid_claude_code_tool_input', 'invalid_tool_input_schema'].includes(issue.reason)
      ? { rejectedToolName: issue.context?.toolName || issue.diagnostics?.rejectedToolName || null }
      : {}),
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
      targetlessToolRecovery: plan.targetlessToolRecovery,
      toolInputSchemaRecovery: plan.toolInputSchemaRecovery,
      recoveryThinkingDisabled,
      ...((plan.targetlessToolRecovery || plan.toolInputSchemaRecovery) ? { rejectedToolName: plan.rejectedToolName } : {}),
    },
  };
}

export function validateAnthropicOutputRequiredRecovery(output, plan) {
  if (plan?.mode !== 'output_required') return { ok: true };
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (calls.length > 0) return { ok: true };
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  const repeatedPlaceholder = Boolean(
    finalText
    && plan.rejectPlaceholderCompletion
    && isAnthropicPlaceholderCompletionText(finalText)
  );
  if (finalText && !repeatedPlaceholder) return { ok: true };
  return {
    ok: false,
    reason: plan.originReason || 'thinking_without_output',
    detail: repeatedPlaceholder
      ? 'The output-required Recovery repeated a placeholder instead of producing substantive output or a Tool Call.'
      : 'The output-required Recovery ended without visible output or a Tool Call.',
    retryable: false,
    diagnostics: {
      requestToolCount: Array.isArray(plan.candidateNames) ? plan.candidateNames.length : 0,
      requestToolNames: Array.isArray(plan.candidateNames) ? [...plan.candidateNames] : [],
      outputRecoveryAttempted: true,
      placeholderRecoveryAttempted: Boolean(plan.rejectPlaceholderCompletion),
      placeholderCompletionDetected: repeatedPlaceholder,
      ...(repeatedPlaceholder ? { placeholderText: normalizePlaceholderCompletionText(finalText) } : {}),
      finalTextChars: finalText.length,
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
  const recoveryThinkingDisabled = applyRecoveryThinkingPolicy(
    body,
    config?.actionRequiredRecoveryDisableThinking,
  );
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
      recoveryThinkingDisabled,
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
