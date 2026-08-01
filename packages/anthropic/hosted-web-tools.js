const HOSTED_WEB_SEARCH_TYPE = 'web_search_20250305';
const HOSTED_WEB_SEARCH_NAME = 'web_search';
const INTERNAL_POLICY_KEY = 'x_vllm_proxy_hosted_web_search';

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedDomains(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase().replace(/^\.+/, '') : '')
    .filter(Boolean))];
}

export function isAnthropicHostedWebSearchTool(tool) {
  return plainObject(tool)
    && tool.type === HOSTED_WEB_SEARCH_TYPE
    && tool.name === HOSTED_WEB_SEARCH_NAME;
}

function hostedWebSearchInputSchema() {
  return {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      allowed_domains: { type: 'array', items: { type: 'string' } },
      blocked_domains: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
    additionalProperties: false,
  };
}

export function normalizeAnthropicHostedWebSearchTools(body, config = {}) {
  if (!Array.isArray(body?.tools)) return body;
  const hosted = body.tools.filter(isAnthropicHostedWebSearchTool);
  if (hosted.length === 0) return body;
  if (!config.managedWebSearchEnabled) {
    const error = new Error('Anthropic hosted web search requires CLAUDE_CODE_WEBSEARCH_BRIDGE_ENABLED=true.');
    error.code = 'anthropic_hosted_web_search_unavailable';
    error.details = {
      retryable: false,
      hostedToolType: HOSTED_WEB_SEARCH_TYPE,
      hostedToolName: HOSTED_WEB_SEARCH_NAME,
    };
    throw error;
  }

  body.tools = body.tools.map((tool) => {
    if (!isAnthropicHostedWebSearchTool(tool)) return tool;
    return {
      name: HOSTED_WEB_SEARCH_NAME,
      description: 'Search the web using the proxy-managed search provider. Return current, source-based results for the supplied query.',
      input_schema: hostedWebSearchInputSchema(),
      [INTERNAL_POLICY_KEY]: {
        maxUses: positiveInteger(tool.max_uses),
        allowedDomains: normalizedDomains(tool.allowed_domains),
        blockedDomains: normalizedDomains(tool.blocked_domains),
      },
    };
  });
  return body;
}

export function consumeAnthropicHostedWebSearchPolicy(body) {
  if (!Array.isArray(body?.tools)) return { body, policy: null };
  let policy = null;
  for (const tool of body.tools) {
    if (!plainObject(tool) || !plainObject(tool[INTERNAL_POLICY_KEY])) continue;
    const current = tool[INTERNAL_POLICY_KEY];
    const maxUses = positiveInteger(current.maxUses);
    if (!policy) {
      policy = {
        maxUses,
        allowedDomains: normalizedDomains(current.allowedDomains),
        blockedDomains: normalizedDomains(current.blockedDomains),
      };
    } else if (maxUses !== null) {
      policy.maxUses = policy.maxUses === null ? maxUses : Math.min(policy.maxUses, maxUses);
    }
    delete tool[INTERNAL_POLICY_KEY];
  }
  return { body, policy };
}

export function applyHostedWebSearchDefaults(input, policy) {
  if (!policy) return input;
  const body = plainObject(input) ? structuredClone(input) : {};
  if (!Array.isArray(body.allowed_domains) && policy.allowedDomains.length > 0) body.allowed_domains = [...policy.allowedDomains];
  if (!Array.isArray(body.blocked_domains) && policy.blockedDomains.length > 0) body.blocked_domains = [...policy.blockedDomains];
  return body;
}
