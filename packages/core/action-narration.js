const ACTION_TEXT_LIMIT = 768;

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTION_TEXT_LIMIT);
}

const ACTION_VERBS_ZH = '(?:開始|著手|建立|創建|新增|修改|執行|啟動|準備|產生|生成|撰寫|檢查|查看|測試|驗證|研究|搜尋)';
const CONTINUATION_ACTIONS_ZH = '(?:執行|處理|進行|工作|任務|階段|建立|創建|新增|修改|啟動|準備|產生|生成|撰寫|檢查|查看|測試|驗證|研究|搜尋)';
const CHINESE_ACTION_NARRATION = new RegExp(
  `^(?:好的?[，,。.!\\s]*)?(?:(?:我來|我先|讓我)${ACTION_VERBS_ZH}|我現在(?:會|將)?(?:先|來)?${ACTION_VERBS_ZH}|我(?:現在)?(?:開始|繼續)${CONTINUATION_ACTIONS_ZH}|(?:首先|接下來)我(?:會|將|先)?${ACTION_VERBS_ZH})`,
  'u',
);

const ENGLISH_ACTION_NARRATION = /^(?:okay[,.!\s]*)?(?:(?:i(?:'ll| will)\s+(?:start|begin|continue))|i(?: am|'m)\s+(?:starting|beginning|continuing)|i will now\s+(?:start|begin|continue|create|set up|launch|execute|implement|write|generate|inspect|test|verify|research|search|modify|update)|let me\s+(?:start|begin|continue|create|set up|launch|execute|implement|write|generate|inspect|test|verify|research|search|modify|update)|first[,.:\s]+i(?:'ll| will)\s+(?:start|begin|create|set up|launch|execute|implement|write|generate|inspect|test|verify|research|search|modify|update)|next[,.:\s]+i(?:'ll| will)\s+(?:start|begin|continue|create|set up|launch|execute|implement|write|generate|inspect|test|verify|research|search|modify|update))/i;

export function looksLikeActionNarration(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const segments = normalized.split(/(?<=[。！？.!?])\s*/u).filter(Boolean).slice(0, 3);
  return segments.some((segment) => CHINESE_ACTION_NARRATION.test(segment) || ENGLISH_ACTION_NARRATION.test(segment));
}
