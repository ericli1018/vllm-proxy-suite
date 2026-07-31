import { looksLikeActionNarration } from '../core/action-narration.js';
import { toolName } from './tool-classifier.js';

function normalizeToolChoice(choice, toolCount) {
  if (choice === undefined || choice === null || choice === '') return toolCount > 0 ? 'auto' : 'none';
  if (typeof choice === 'string') return choice;
  if (choice && typeof choice === 'object') {
    const name = choice.name || choice.function?.name || null;
    const type = choice.type || 'object';
    return name ? `${type}:${name}` : type;
  }
  return String(choice);
}

export function summarizeOpenAiToolContext(body = {}) {
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) tools.push(...item.tools);
    }
  }
  const names = tools.map((tool) => toolName(tool)).filter(Boolean);
  const requestToolChoice = normalizeToolChoice(body.tool_choice, tools.length);
  return {
    requestToolCount: tools.length,
    requestToolNames: names,
    requestToolChoice,
    requestToolsEnabled: tools.length > 0 && requestToolChoice !== 'none',
    parallelToolCallsRequested: typeof body.parallel_tool_calls === 'boolean'
      ? body.parallel_tool_calls
      : null,
  };
}

export { looksLikeActionNarration };

export function detectActionlessCompletion({ requestBody, output, completion, recovery = false } = {}) {
  if (!completion?.responseCompleted || completion?.responseStatus !== 'completed') return { ok: true };
  const toolContext = summarizeOpenAiToolContext(requestBody);
  if (!toolContext.requestToolsEnabled) return { ok: true };
  if (Array.isArray(output?.toolCalls) && output.toolCalls.length > 0) return { ok: true };
  const finalText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  if (!finalText || !looksLikeActionNarration(finalText)) return { ok: true };

  return {
    ok: false,
    reason: 'actionless_completion',
    detail: 'The response described future actions but completed without calling an available tool.',
    retryable: !recovery,
    diagnostics: {
      ...toolContext,
      actionlessRecoveryAttempted: Boolean(recovery),
      finalTextChars: finalText.length,
      actionNarrationDetected: true,
    },
  };
}
