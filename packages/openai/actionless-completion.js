import { toolName } from './tool-classifier.js';

const ACTION_TEXT_LIMIT = 768;

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
  const tools = Array.isArray(body.tools) ? body.tools : [];
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

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTION_TEXT_LIMIT);
}

const ACTION_VERBS_ZH = '(?:開始|著手|建立|創建|新增|修改|執行|啟動|準備|產生|生成|撰寫|檢查|研究|搜尋)';
const CHINESE_ACTION_NARRATION = new RegExp(
  `^(?:好的?[，,。.!\\s]*)?(?:(?:我來|我先|讓我)${ACTION_VERBS_ZH}|我現在(?:會|將)?(?:先|來)?${ACTION_VERBS_ZH}|(?:首先|接下來)我(?:會|將|先)?${ACTION_VERBS_ZH})`,
  'u',
);

const ENGLISH_ACTION_NARRATION = /^(?:okay[,.!\s]*)?(?:(?:i(?:'ll| will)\s+(?:start|begin))|i will now\s+(?:start|begin|create|set up|launch|execute|implement|write|generate|inspect|research|search|modify|update)|let me\s+(?:start|begin|create|set up|launch|execute|implement|write|generate|inspect|research|search|modify|update)|first[,.:\s]+i(?:'ll| will)\s+(?:start|begin|create|set up|launch|execute|implement|write|generate|inspect|research|search|modify|update)|next[,.:\s]+i(?:'ll| will)\s+(?:start|begin|create|set up|launch|execute|implement|write|generate|inspect|research|search|modify|update))/i;

export function looksLikeActionNarration(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const segments = normalized.split(/(?<=[。！？.!?])\s*/u).filter(Boolean).slice(0, 3);
  return segments.some((segment) => CHINESE_ACTION_NARRATION.test(segment) || ENGLISH_ACTION_NARRATION.test(segment));
}

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
