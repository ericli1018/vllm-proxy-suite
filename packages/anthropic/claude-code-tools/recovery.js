import { createHash } from 'node:crypto';

const TOOL_NAMES = Object.freeze({
  READ: 'Read',
  EDIT: 'Edit',
  WRITE: 'Write',
  NOTEBOOK_EDIT: 'NotebookEdit',
  BASH: 'Bash',
});

function invalid(reason, detail = reason, context = undefined) {
  return context === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, context };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function fingerprint(name, input) {
  return createHash('sha256')
    .update(String(name))
    .update('\0')
    .update(JSON.stringify(canonicalize(input || {})))
    .digest('hex');
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (isPlainObject(content)) {
    if (typeof content.text === 'string') return content.text;
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

function toolByName(request, name) {
  return Array.isArray(request?.tools)
    ? request.tools.find((tool) => tool?.name === name) || null
    : null;
}

function targetPathFor(name, input) {
  if (!isPlainObject(input)) return null;
  if (name === TOOL_NAMES.NOTEBOOK_EDIT) {
    return typeof input.notebook_path === 'string' && input.notebook_path
      ? input.notebook_path
      : (typeof input.file_path === 'string' && input.file_path ? input.file_path : null);
  }
  return typeof input.file_path === 'string' && input.file_path ? input.file_path : null;
}

function schemaTypeMatches(value, type) {
  if (Array.isArray(type)) return type.some((entry) => schemaTypeMatches(value, entry));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return true;
}

function validateAgainstToolSchema(tool, input) {
  if (!tool) return invalid('tool_not_exposed');
  if (!isPlainObject(input)) return invalid('invalid_claude_code_tool_input');
  const schema = isPlainObject(tool.input_schema) ? tool.input_schema : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!(key in input)) return invalid('invalid_claude_code_tool_input', `missing required field: ${key}`);
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property || property.type === undefined) continue;
    if (!schemaTypeMatches(value, property.type)) {
      return invalid('invalid_claude_code_tool_input', `field ${key} does not match schema`);
    }
    if (
      Array.isArray(property.enum)
      && !property.enum.some((candidate) => JSON.stringify(canonicalize(candidate)) === JSON.stringify(canonicalize(value)))
    ) {
      return invalid('invalid_claude_code_tool_input', `field ${key} is outside the allowed enum`);
    }
    if (
      Object.hasOwn(property, 'const')
      && JSON.stringify(canonicalize(property.const)) !== JSON.stringify(canonicalize(value))
    ) {
      return invalid('invalid_claude_code_tool_input', `field ${key} does not match const`);
    }
  }
  return { ok: true };
}

function isMutationTool(name) {
  return [TOOL_NAMES.EDIT, TOOL_NAMES.WRITE, TOOL_NAMES.NOTEBOOK_EDIT].includes(name);
}

function enabledForTool(name, config) {
  if (!config?.claudeCodeToolRecoveryEnabled) return false;
  if (name === TOOL_NAMES.EDIT) return config.claudeCodeEditRecoveryEnabled !== false;
  if (name === TOOL_NAMES.WRITE) return config.claudeCodeWriteRecoveryEnabled !== false;
  if (name === TOOL_NAMES.NOTEBOOK_EDIT) return config.claudeCodeNotebookEditRecoveryEnabled !== false;
  return false;
}

function collectHistory(request, config) {
  const toolUses = new Map();
  const failedFingerprints = new Map();
  const freshReads = new Map();

  const invalidateTarget = (target) => {
    if (target) freshReads.delete(target);
  };

  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (message?.role === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || !block.id || !block.name || !isPlainObject(block.input)) continue;
        toolUses.set(block.id, {
          id: block.id,
          name: block.name,
          input: structuredClone(block.input),
          targetPath: targetPathFor(block.name, block.input),
          fingerprint: fingerprint(block.name, block.input),
        });
      }
      continue;
    }

    if (message?.role !== 'user') continue;
    for (const block of blocks) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      const call = toolUses.get(block.tool_use_id);
      if (!call) continue;
      const failed = block.is_error === true;
      const resultText = contentToText(block.content);

      if (failed) {
        failedFingerprints.set(call.fingerprint, { ...call, resultText });
        if (call.name === TOOL_NAMES.BASH && config?.claudeCodeBashInvalidatesReads !== false) {
          freshReads.clear();
        } else if (isMutationTool(call.name)) {
          invalidateTarget(call.targetPath);
        }
        continue;
      }

      if (call.name === TOOL_NAMES.READ && call.targetPath) {
        freshReads.set(call.targetPath, { ...call, resultText });
        continue;
      }
      if (call.name === TOOL_NAMES.BASH && config?.claudeCodeBashInvalidatesReads !== false) {
        freshReads.clear();
        continue;
      }
      if (isMutationTool(call.name)) invalidateTarget(call.targetPath);
    }
  }

  return { failedFingerprints, freshReads };
}

function repeatedReason(name) {
  if (name === TOOL_NAMES.EDIT) return 'repeated_failed_edit_tool_call';
  if (name === TOOL_NAMES.WRITE) return 'repeated_failed_write_tool_call';
  if (name === TOOL_NAMES.NOTEBOOK_EDIT) return 'repeated_failed_notebook_edit_tool_call';
  return 'repeated_failed_tool_call';
}

function buildIssueContext({ request, call, history, failed = null }) {
  const targetPath = targetPathFor(call.name, call.parsedArguments);
  return {
    toolName: call.name,
    targetPath,
    rejectedArguments: structuredClone(call.parsedArguments || {}),
    rejectedFingerprint: fingerprint(call.name, call.parsedArguments || {}),
    failedResultText: failed?.resultText || '',
    hasFreshRead: Boolean(targetPath && history.freshReads.has(targetPath)),
    readToolAvailable: Boolean(toolByName(request, TOOL_NAMES.READ)),
  };
}

export function analyzeClaudeCodeToolAttempt({ request, output, config }) {
  if (!config?.claudeCodeToolRecoveryEnabled) return { ok: true };
  const history = collectHistory(request, config);
  for (const call of Array.isArray(output?.toolCalls) ? output.toolCalls : []) {
    if (!enabledForTool(call?.name, config)) continue;

    const tool = toolByName(request, call.name);
    const schema = validateAgainstToolSchema(tool, call.parsedArguments);
    const context = buildIssueContext({ request, call, history });
    if (!schema.ok) return invalid(schema.reason, schema.detail, context);

    if (!context.targetPath) {
      return invalid('invalid_claude_code_tool_input', 'tool call is missing its target path', context);
    }

    if (
      call.name === TOOL_NAMES.EDIT
      && call.parsedArguments.old_string === call.parsedArguments.new_string
    ) {
      return invalid('no_op_edit_tool_call', 'Edit old_string and new_string are identical', context);
    }

    const failed = history.failedFingerprints.get(context.rejectedFingerprint);
    if (failed) {
      const failedContext = buildIssueContext({ request, call, history, failed });
      return invalid(repeatedReason(call.name), failed.resultText || repeatedReason(call.name), failedContext);
    }
  }
  return { ok: true };
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

function toolInstruction(plan, issue) {
  const quotedTarget = JSON.stringify(plan.targetPath);
  const common = [
    'Recovery is expected and the original task remains solvable.',
    'The previous generation was discarded and did not change any file or task state.',
    'Use only the original request, accepted tool results, and current observable evidence.',
    'Do not explain why the previous attempt failed.',
    'Produce exactly one tool call and no final response text.',
  ];
  if (plan.mode === 'read_target') {
    common.push(`Call ${TOOL_NAMES.READ} for exactly this target JSON string: ${quotedTarget}.`);
    common.push('Do not read a different path and do not perform a mutation in this recovery attempt.');
  } else if (plan.toolName === TOOL_NAMES.EDIT) {
    common.push(`Call ${TOOL_NAMES.EDIT} for exactly this target JSON string: ${quotedTarget}.`);
    common.push('Reconstruct old_string from the latest accepted file evidence, make new_string materially different, and do not widen replace_all.');
  } else if (plan.toolName === TOOL_NAMES.WRITE) {
    common.push(`Call ${TOOL_NAMES.WRITE} for exactly this target JSON string: ${quotedTarget}.`);
    common.push('Use corrected content and do not repeat the rejected arguments unchanged.');
  } else if (plan.toolName === TOOL_NAMES.NOTEBOOK_EDIT) {
    common.push(`Call ${TOOL_NAMES.NOTEBOOK_EDIT} for exactly this notebook JSON string: ${quotedTarget}.`);
    common.push('Use the tool schema supplied in this request and do not repeat the rejected arguments unchanged.');
  }
  common.push(`Recovery reason: ${issue.reason}.`);
  return common.join(' ');
}

export function buildClaudeCodeToolRecovery({ original, prepared = null, issue, config }) {
  if (!issue || issue.ok !== false || !issue.context) {
    throw new TypeError('A Claude Code tool recovery issue is required');
  }
  const body = structuredClone(prepared || original);
  capRecoverySampling(body, config);

  const context = issue.context;
  if (!context.targetPath) {
    throw new Error('Claude Code tool recovery requires an exact target path');
  }
  const readAvailable = Boolean(toolByName(original, TOOL_NAMES.READ));
  const useRead = Boolean(readAvailable && !context.hasFreshRead);
  const plan = useRead
    ? {
      mode: 'read_target',
      toolName: TOOL_NAMES.READ,
      targetPath: context.targetPath,
      rejectedToolName: context.toolName,
      rejectedArguments: structuredClone(context.rejectedArguments || {}),
      rejectedFingerprint: context.rejectedFingerprint,
    }
    : {
      mode: 'retry_mutation',
      toolName: context.toolName,
      targetPath: context.targetPath,
      rejectedArguments: structuredClone(context.rejectedArguments || {}),
      rejectedFingerprint: context.rejectedFingerprint,
    };

  const selected = toolByName(original, plan.toolName);
  if (!selected) throw new Error(`Recovery tool is not exposed: ${plan.toolName}`);
  plan.inputSchema = structuredClone(selected.input_schema || {});
  body.tools = [structuredClone(selected)];
  body.tool_choice = { type: 'tool', name: plan.toolName };
  body.system = appendSystem(body.system, toolInstruction(plan, issue));
  return { body, plan };
}

function recoveryCall(output) {
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (calls.length !== 1) return invalid('forced_tool_call_missing');
  if (typeof output?.finalText === 'string' && output.finalText.trim()) {
    return invalid('forced_tool_recovery_has_text');
  }
  return { ok: true, call: calls[0] };
}

export function validateClaudeCodeToolRecovery(output, plan) {
  const selected = recoveryCall(output);
  if (!selected.ok) return selected;
  const call = selected.call;
  if (call.name !== plan.toolName) return invalid('forced_tool_name_mismatch');
  if (!isPlainObject(call.parsedArguments)) return invalid('invalid_claude_code_tool_input');
  if (plan.inputSchema) {
    const schemaValidation = validateAgainstToolSchema(
      { name: plan.toolName, input_schema: plan.inputSchema },
      call.parsedArguments,
    );
    if (!schemaValidation.ok) return schemaValidation;
  }
  const actualTarget = targetPathFor(call.name, call.parsedArguments);
  if (actualTarget !== plan.targetPath) return invalid('recovery_target_mismatch');

  if (plan.mode === 'read_target') return { ok: true };

  if (call.name === TOOL_NAMES.EDIT) {
    if (typeof call.parsedArguments.old_string !== 'string' || typeof call.parsedArguments.new_string !== 'string') {
      return invalid('invalid_claude_code_tool_input');
    }
    if (call.parsedArguments.old_string === call.parsedArguments.new_string) {
      return invalid('no_op_edit_tool_call');
    }
    if (plan.rejectedArguments?.replace_all !== true && call.parsedArguments.replace_all === true) {
      return invalid('recovery_scope_widened');
    }
  }

  const currentFingerprint = fingerprint(call.name, call.parsedArguments);
  if (plan.rejectedFingerprint && currentFingerprint === plan.rejectedFingerprint) {
    return invalid(repeatedReason(call.name));
  }
  return { ok: true };
}

export const CLAUDE_CODE_TOOL_NAMES = TOOL_NAMES;
