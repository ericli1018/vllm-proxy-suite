function definitionOf(tool) {
  if (!tool || tool.type !== 'function') return null;
  if (tool.function && typeof tool.function === 'object') {
    return { tool, name: tool.function.name || '', description: tool.function.description || '', schema: tool.function.parameters || {} };
  }
  return { tool, name: tool.name || '', description: tool.description || '', schema: tool.parameters || {} };
}

function schemaText(schema) {
  try { return JSON.stringify(schema).toLowerCase(); } catch { return ''; }
}

const LOCAL_PATTERN = /\b(local|filesystem|file system|repository|repo|source code|database|sql|memory|shell|grep|ripgrep|workspace|calendar|email|gmail)\b/i;
const NETWORK_PATTERN = /\b(web|internet|online|remote|http|https|url|uri|browser|website|network)\b/i;
const LOOKUP_PATTERN = /\b(search|lookup|query|discover|find|research|browse|serp)\b/i;
const DOWNLOAD_PATTERN = /\b(fetch|download|retrieve|read[_ -]?url|open[_ -]?url|navigate|load[_ -]?url|get[_ -]?url|crawl)\b/i;
const LOOKUP_SCHEMA_PATTERN = /"(query|queries|keyword|keywords|search_term|question)"/i;
const DOWNLOAD_SCHEMA_PATTERN = /"(url|urls|uri|href|link|resource)"/i;

export function toolName(tool) {
  return definitionOf(tool)?.name || '';
}

export function classifyTools(tools = [], options = {}) {
  const lookupNames = new Set(options.lookupNames || []);
  const downloadNames = new Set(options.downloadNames || []);
  const hybridNames = new Set(options.hybridNames || []);
  return tools.map((tool) => {
    const definition = definitionOf(tool);
    if (!definition) return { tool, name: '', capability: 'unknown', reason: 'unsupported_tool_shape' };
    const { name, description, schema } = definition;
    if (hybridNames.has(name)) return { tool, name, capability: 'network_hybrid', reason: 'configured' };
    if (lookupNames.has(name)) return { tool, name, capability: 'network_lookup', reason: 'configured' };
    if (downloadNames.has(name)) return { tool, name, capability: 'network_download', reason: 'configured' };

    const text = `${name} ${description} ${schemaText(schema)}`.replaceAll('_', ' ');
    if (LOCAL_PATTERN.test(text)) return { tool, name, capability: 'non_network', reason: 'local_semantics' };
    const network = NETWORK_PATTERN.test(text);
    const lookup = LOOKUP_PATTERN.test(text) && (network || LOOKUP_SCHEMA_PATTERN.test(schemaText(schema)));
    const download = DOWNLOAD_PATTERN.test(text) || (network && DOWNLOAD_SCHEMA_PATTERN.test(schemaText(schema)));
    const capability = lookup && download ? 'network_hybrid' : lookup ? 'network_lookup' : download ? 'network_download' : 'unknown';
    return { tool, name, capability, reason: 'semantic' };
  });
}

function flattenText(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenText(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenText(item, output);
  return output;
}

export function extractHttpUrls(context) {
  const text = flattenText(context).join('\n');
  return [...new Set(text.match(/https?:\/\/[^\s<>"'`]+/gi) || [])];
}

export function planNetworkRecovery({ tools = [], context = [], options = {} }) {
  const classified = classifyTools(tools, options);
  const urls = extractHttpUrls(context);
  const by = (capability) => classified.filter((entry) => entry.capability === capability);
  let candidates = [];
  let mode = 'none';
  if (urls.length > 0 && by('network_download').length) {
    candidates = by('network_download');
    mode = 'network_download';
  } else if (urls.length > 0 && by('network_hybrid').length) {
    candidates = by('network_hybrid');
    mode = 'network_hybrid';
  } else if (by('network_lookup').length) {
    candidates = by('network_lookup');
    mode = 'network_lookup';
  } else if (by('network_hybrid').length) {
    candidates = by('network_hybrid');
    mode = 'network_hybrid';
  }
  return {
    mode,
    urls,
    candidates,
    candidateNames: candidates.map((entry) => entry.name),
    classified,
  };
}
