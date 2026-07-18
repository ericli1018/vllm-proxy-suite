import { toolName } from './tool-classifier.js';

function appendInstruction(body, api, text) {
  if (api === 'responses') {
    body.instructions = body.instructions ? `${body.instructions}\n\n${text}` : text;
    return;
  }
  if (!Array.isArray(body.messages)) body.messages = [];
  body.messages.push({ role: 'system', content: text });
}

function recoveryInstruction(reason, plan) {
  const network = plan?.mode && plan.mode !== 'none'
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
  const network = plan?.mode && plan.mode !== 'none';
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

  if (network) {
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
  if (output.finalText?.trim() || output.toolCalls.length !== 1) return { ok: false, reason: 'forced_tool_call_required' };
  const tool = output.toolCalls[0];
  if (!plan.candidateNames.includes(tool.name)) return { ok: false, reason: 'unexpected_recovery_tool' };
  if (!tool.parsedArguments || typeof tool.parsedArguments !== 'object' || Array.isArray(tool.parsedArguments)) return { ok: false, reason: 'invalid_recovery_tool_arguments' };
  return { ok: true };
}
