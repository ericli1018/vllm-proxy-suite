const EXPLICIT_TEXT_LIMIT = 192;

function normalizeExecutionText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXPLICIT_TEXT_LIMIT);
}

const ZH_EXPLICIT_CONTINUE = /^(?:好(?:的)?[，,。.!！\s]*)?(?:(?:請|麻煩)(?:你)?\s*)?(?:現在\s*)?(?:開始(?:你(?:的)?)?(?:工作|任務|執行|實作|修改)?|開始(?:工作|執行|實作|修改)|繼續(?:做|工作|執行|實作|修改|下去)?|接著做|往下做|直接執行)(?:吧)?[。.!！\s]*$/u;
const EN_EXPLICIT_CONTINUE = /^(?:okay[,.!\s]*)?(?:please\s+)?(?:start(?:\s+your)?\s+(?:work|task|implementation|modification)|start\s+working|begin(?:\s+the)?\s+(?:work|task|implementation)|continue(?:\s+(?:the|your))?\s*(?:work|task|implementation)?|continue\s+working|proceed|go\s+ahead|do\s+it)[.!\s]*$/i;

export function isExplicitContinueInstruction(value) {
  const text = normalizeExecutionText(value);
  if (!text) return false;
  return ZH_EXPLICIT_CONTINUE.test(text) || EN_EXPLICIT_CONTINUE.test(text);
}
