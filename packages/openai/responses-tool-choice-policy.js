const TOOL_CHOICE_DIAGNOSTICS = Symbol('responsesToolChoiceDiagnostics');
const EXPLICIT_TEXT_LIMIT = 192;

const POLICIES = new Set(['preserve', 'required_on_explicit_continue']);

export function normalizeResponsesToolChoicePolicy(value) {
  const normalized = String(value ?? 'preserve').trim().toLowerCase();
  return POLICIES.has(normalized) ? normalized : 'preserve';
}

function additionalTools(input) {
  if (!Array.isArray(input)) return [];
  const tools = [];
  for (const item of input) {
    if (item?.type === 'additional_tools' && Array.isArray(item.tools)) tools.push(...item.tools);
  }
  return tools;
}

function toolCount(body) {
  return (Array.isArray(body?.tools) ? body.tools.length : 0) + additionalTools(body?.input).length;
}

function normalizedToolChoice(choice, count) {
  if (choice === undefined || choice === null || choice === '') return count > 0 ? 'auto' : 'none';
  if (typeof choice === 'string') return choice.toLowerCase();
  return 'explicit';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => ['input_text', 'output_text', 'text'].includes(block?.type))
    .map((block) => block.text || '')
    .join('\n');
}

function latestInput(body) {
  if (typeof body?.input === 'string') return { kind: 'user', text: body.input };
  if (!Array.isArray(body?.input)) return { kind: 'none', text: '' };

  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'additional_tools') continue;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      return { kind: 'tool_result', text: '' };
    }
    if (item.type === 'message') {
      return {
        kind: item.role === 'user' ? 'user' : (item.role || 'message'),
        text: contentText(item.content),
      };
    }
    return { kind: item.type || 'other', text: '' };
  }
  return { kind: 'none', text: '' };
}

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

function attachDiagnostics(body, diagnostics) {
  Object.defineProperty(body, TOOL_CHOICE_DIAGNOSTICS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...diagnostics }),
  });
  return body;
}

export function responsesToolChoiceDiagnostics(body = {}) {
  return body?.[TOOL_CHOICE_DIAGNOSTICS] || null;
}

export function applyResponsesToolChoicePolicy(sourceBody = {}, options = {}) {
  const policy = normalizeResponsesToolChoicePolicy(options.policy);
  const body = structuredClone(sourceBody);
  for (const symbol of Object.getOwnPropertySymbols(sourceBody)) {
    const descriptor = Object.getOwnPropertyDescriptor(sourceBody, symbol);
    if (descriptor) Object.defineProperty(body, symbol, descriptor);
  }
  const count = toolCount(body);
  const originalToolChoice = normalizedToolChoice(body.tool_choice, count);
  const latest = latestInput(body);
  const explicitContinueDetected = latest.kind === 'user' && isExplicitContinueInstruction(latest.text);
  const eligible = policy === 'required_on_explicit_continue'
    && count > 0
    && originalToolChoice === 'auto'
    && explicitContinueDetected;

  if (eligible) body.tool_choice = 'required';
  const effectiveToolChoice = normalizedToolChoice(body.tool_choice, count);
  const diagnostics = {
    responsesToolChoicePolicy: policy,
    originalToolChoice,
    effectiveToolChoice,
    toolChoiceRewritten: eligible,
    latestInputKind: latest.kind,
    explicitContinueDetected,
  };

  attachDiagnostics(body, diagnostics);
  return { body, diagnostics };
}
