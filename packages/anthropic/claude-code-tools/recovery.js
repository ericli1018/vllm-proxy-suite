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

function sameJsonValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function schemaFailure(detail, {
  inputPath = '$',
  schemaPath = '$',
  keyword = null,
} = {}) {
  return {
    ok: false,
    reason: 'invalid_claude_code_tool_input',
    detail,
    diagnostics: {
      schemaInputPath: inputPath,
      schemaPath,
      schemaKeyword: keyword,
    },
  };
}

function validateSchemaValue(schema, value, {
  inputPath = '$',
  schemaPath = '$',
  depth = 0,
} = {}) {
  if (depth > 64) return schemaFailure('tool schema nesting exceeds the validation limit', { inputPath, schemaPath, keyword: 'depth' });
  if (schema === true || schema === undefined || schema === null) return { ok: true };
  if (schema === false) return schemaFailure(`value at ${inputPath} is rejected by the tool schema`, { inputPath, schemaPath, keyword: 'falseSchema' });
  if (!isPlainObject(schema)) return { ok: true };
  if (typeof schema.$ref === 'string') return { ok: true };

  if (schema.type !== undefined && !schemaTypeMatches(value, schema.type)) {
    return schemaFailure(`value at ${inputPath} does not match the required type`, { inputPath, schemaPath: `${schemaPath}.type`, keyword: 'type' });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJsonValue(candidate, value))) {
    return schemaFailure(`value at ${inputPath} is outside the allowed enum`, { inputPath, schemaPath: `${schemaPath}.enum`, keyword: 'enum' });
  }
  if (Object.hasOwn(schema, 'const') && !sameJsonValue(schema.const, value)) {
    return schemaFailure(`value at ${inputPath} does not match const`, { inputPath, schemaPath: `${schemaPath}.const`, keyword: 'const' });
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in value)) {
        return schemaFailure(`missing required field: ${key}`, { inputPath, schemaPath: `${schemaPath}.required`, keyword: 'required' });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const result = validateSchemaValue(properties[key], child, {
          inputPath: `${inputPath}.${key}`,
          schemaPath: `${schemaPath}.properties.${key}`,
          depth: depth + 1,
        });
        if (!result.ok) return result;
        continue;
      }

      let patternMatched = false;
      for (const [pattern, childSchema] of Object.entries(patternProperties)) {
        let regexp;
        try { regexp = new RegExp(pattern, 'u'); } catch { continue; }
        if (!regexp.test(key)) continue;
        patternMatched = true;
        const result = validateSchemaValue(childSchema, child, {
          inputPath: `${inputPath}.${key}`,
          schemaPath: `${schemaPath}.patternProperties.${pattern}`,
          depth: depth + 1,
        });
        if (!result.ok) return result;
      }
      if (patternMatched) continue;

      if (schema.additionalProperties === false) {
        return schemaFailure(`field ${key} is not allowed by the tool schema`, {
          inputPath: `${inputPath}.${key}`,
          schemaPath: `${schemaPath}.additionalProperties`,
          keyword: 'additionalProperties',
        });
      }
      if (isPlainObject(schema.additionalProperties)) {
        const result = validateSchemaValue(schema.additionalProperties, child, {
          inputPath: `${inputPath}.${key}`,
          schemaPath: `${schemaPath}.additionalProperties`,
          depth: depth + 1,
        });
        if (!result.ok) return result;
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const result = validateSchemaValue(schema.items, value[index], {
        inputPath: `${inputPath}[${index}]`,
        schemaPath: `${schemaPath}.items`,
        depth: depth + 1,
      });
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

function validateAgainstToolSchema(tool, input) {
  if (!tool) return invalid('tool_not_exposed');
  if (!isPlainObject(input)) {
    return schemaFailure('tool input must be a JSON object', { inputPath: '$', schemaPath: '$', keyword: 'type' });
  }
  const schema = isPlainObject(tool.input_schema) ? tool.input_schema : {};
  return validateSchemaValue(schema, input);
}

function collectUnsupportedPropertyPaths(schema, value, {
  inputPath = '$',
  pathSegments = [],
  depth = 0,
  results = [],
} = {}) {
  if (depth > 64 || !isPlainObject(schema)) return results;
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        collectUnsupportedPropertyPaths(properties[key], child, {
          inputPath: `${inputPath}.${key}`,
          pathSegments: [...pathSegments, key],
          depth: depth + 1,
          results,
        });
        continue;
      }
      const matchingSchemas = [];
      for (const [pattern, childSchema] of Object.entries(patternProperties)) {
        let regexp;
        try { regexp = new RegExp(pattern, 'u'); } catch { continue; }
        if (regexp.test(key)) matchingSchemas.push(childSchema);
      }
      if (matchingSchemas.length > 0) {
        for (const childSchema of matchingSchemas) {
          collectUnsupportedPropertyPaths(childSchema, child, {
            inputPath: `${inputPath}.${key}`,
            pathSegments: [...pathSegments, key],
            depth: depth + 1,
            results,
          });
        }
        continue;
      }
      if (schema.additionalProperties === false) {
        results.push({
          inputPath: `${inputPath}.${key}`,
          pathSegments: [...pathSegments, key],
          propertyName: key,
        });
        continue;
      }
      if (isPlainObject(schema.additionalProperties)) {
        collectUnsupportedPropertyPaths(schema.additionalProperties, child, {
          inputPath: `${inputPath}.${key}`,
          pathSegments: [...pathSegments, key],
          depth: depth + 1,
          results,
        });
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      collectUnsupportedPropertyPaths(schema.items, value[index], {
        inputPath: `${inputPath}[${index}]`,
        pathSegments: [...pathSegments, index],
        depth: depth + 1,
        results,
      });
    }
  }
  return results;
}

function removePath(value, pathSegments) {
  const output = structuredClone(value);
  let current = output;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    current = current?.[pathSegments[index]];
    if (current === undefined || current === null) return null;
  }
  const last = pathSegments[pathSegments.length - 1];
  if (!isPlainObject(current) || typeof last !== 'string' || !Object.hasOwn(current, last)) return null;
  delete current[last];
  return output;
}

function buildSingleAdditionalPropertyCorrection(tool, input) {
  if (!tool || !isPlainObject(input) || !isPlainObject(tool.input_schema)) return null;
  const unsupported = collectUnsupportedPropertyPaths(tool.input_schema, input);
  if (unsupported.length !== 1) return null;
  const candidate = unsupported[0];
  const expectedArguments = removePath(input, candidate.pathSegments);
  if (!expectedArguments) return null;
  const correctedValidation = validateAgainstToolSchema(tool, expectedArguments);
  if (!correctedValidation.ok) return null;
  return {
    ...candidate,
    expectedArguments,
  };
}

export function validateExposedClaudeCodeToolCalls({ request, output }) {
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (calls.length === 0) return { ok: true, toolCallCount: 0, toolNames: [] };
  for (const call of calls) {
    const tool = toolByName(request, call?.name);
    const validation = validateAgainstToolSchema(tool, call?.parsedArguments);
    if (!validation.ok) {
      const schemaCorrection = validation.diagnostics?.schemaKeyword === 'additionalProperties'
        ? buildSingleAdditionalPropertyCorrection(tool, call?.parsedArguments)
        : null;
      return {
        ...validation,
        reason: 'invalid_tool_input_schema',
        context: {
          toolName: call?.name || null,
          toolCallId: call?.id || null,
          rejectedArguments: isPlainObject(call?.parsedArguments)
            ? structuredClone(call.parsedArguments)
            : null,
          ...(schemaCorrection ? { schemaCorrection } : {}),
        },
        diagnostics: {
          ...(validation.diagnostics || {}),
          rejectedToolName: call?.name || null,
          rejectedToolCallId: call?.id || null,
          targetedSchemaCorrectionAvailable: Boolean(schemaCorrection),
          targetedSchemaCorrection: Boolean(schemaCorrection),
          ...(schemaCorrection ? {
            removedInputPath: schemaCorrection.inputPath,
            removedPropertyName: schemaCorrection.propertyName,
          } : {}),
        },
      };
    }
  }
  return {
    ok: true,
    toolCallCount: calls.length,
    toolNames: calls.map((call) => call.name),
  };
}

export function isTargetedToolInputSchemaCorrectionIssue(issue) {
  return Boolean(
    issue
    && issue.ok === false
    && issue.reason === 'invalid_tool_input_schema'
    && issue.context?.toolName
    && isPlainObject(issue.context?.rejectedArguments)
    && issue.context?.schemaCorrection
    && isPlainObject(issue.context.schemaCorrection.expectedArguments)
    && issue.diagnostics?.schemaKeyword === 'additionalProperties'
    && issue.diagnostics?.targetedSchemaCorrectionAvailable === true
  );
}

function isMutationTool(name) {
  return [TOOL_NAMES.EDIT, TOOL_NAMES.WRITE, TOOL_NAMES.NOTEBOOK_EDIT].includes(name);
}

export function isTargetlessClaudeCodeToolRecoveryIssue(issue) {
  return Boolean(
    issue
    && issue.ok === false
    && issue.reason === 'invalid_claude_code_tool_input'
    && issue.context
    && isMutationTool(issue.context.toolName)
    && !issue.context.targetPath
  );
}

function enabledForTool(name, config) {
  if (!config?.claudeCodeToolRecoveryEnabled) return false;
  if (name === TOOL_NAMES.EDIT) return config.claudeCodeEditRecoveryEnabled !== false;
  if (name === TOOL_NAMES.WRITE) return config.claudeCodeWriteRecoveryEnabled !== false;
  if (name === TOOL_NAMES.NOTEBOOK_EDIT) return config.claudeCodeNotebookEditRecoveryEnabled !== false;
  return false;
}

function classifyMutationFailure(resultText) {
  const normalized = String(resultText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (
    normalized.includes('file has not been read yet')
    && (
      normalized.includes('read it first before writing')
      || normalized.includes('read it before writing')
      || normalized.includes('read it before overwriting')
    )
  ) return 'read_precondition';
  return 'deterministic_mutation_failure';
}

function repeatedFailureMessage(name) {
  return `The model repeated a ${name || 'tool'} call that previously failed.`;
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
        failedFingerprints.set(call.fingerprint, {
          ...call,
          resultText,
          failureKind: isMutationTool(call.name)
            ? classifyMutationFailure(resultText)
            : 'tool_failure',
        });
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
    failedResultKind: failed?.failureKind || null,
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
      const resolvedReadPrecondition = failed.failureKind === 'read_precondition'
        && failedContext.hasFreshRead;
      if (!resolvedReadPrecondition) {
        return invalid(
          repeatedReason(call.name),
          repeatedFailureMessage(call.name),
          failedContext,
        );
      }
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
  const maxAuxiliaryTextBytes = Number.isSafeInteger(config?.claudeCodeForcedToolRecoveryMaxTextBytes)
    && config.claudeCodeForcedToolRecoveryMaxTextBytes >= 0
    ? config.claudeCodeForcedToolRecoveryMaxTextBytes
    : 1024;
  const plan = useRead
    ? {
      mode: 'read_target',
      toolName: TOOL_NAMES.READ,
      targetPath: context.targetPath,
      rejectedToolName: context.toolName,
      rejectedArguments: structuredClone(context.rejectedArguments || {}),
      rejectedFingerprint: context.rejectedFingerprint,
      maxAuxiliaryTextBytes,
    }
    : {
      mode: 'retry_mutation',
      toolName: context.toolName,
      targetPath: context.targetPath,
      rejectedArguments: structuredClone(context.rejectedArguments || {}),
      rejectedFingerprint: context.rejectedFingerprint,
      maxAuxiliaryTextBytes,
    };

  const selected = toolByName(original, plan.toolName);
  if (!selected) throw new Error(`Recovery tool is not exposed: ${plan.toolName}`);
  plan.inputSchema = structuredClone(selected.input_schema || {});
  body.tools = [structuredClone(selected)];
  body.tool_choice = { type: 'tool', name: plan.toolName };
  body.system = appendSystem(body.system, toolInstruction(plan, issue));
  return { body, plan };
}

function schemaCorrectionInstruction(plan) {
  return [
    'Schema correction recovery. The previous generation was discarded and did not change task or tool state.',
    `Re-emit exactly one ${plan.toolName} tool call and no final response text.`,
    `Remove only the unsupported input property at ${plan.removedInputPath}.`,
    'Preserve all other argument values exactly and do not add, infer, summarize, or rewrite any value.',
    'Use the expected corrected arguments supplied below as the exact semantic payload.',
    `Rejected arguments JSON: ${JSON.stringify(plan.rejectedArguments)}.`,
    `Expected corrected arguments JSON: ${JSON.stringify(plan.expectedArguments)}.`,
  ].join(' ');
}

export function buildClaudeCodeSchemaCorrectionRecovery({ original, prepared = null, issue, config }) {
  if (!isTargetedToolInputSchemaCorrectionIssue(issue)) {
    throw new TypeError('A targeted Tool Input Schema correction issue is required');
  }
  const selected = toolByName(original, issue.context.toolName);
  if (!selected) throw new Error(`Recovery tool is not exposed: ${issue.context.toolName}`);

  const body = structuredClone(prepared || original);
  capRecoverySampling(body, config);
  const plan = {
    mode: 'schema_correction',
    originReason: issue.reason,
    toolName: issue.context.toolName,
    rejectedToolCallId: issue.context.toolCallId || null,
    rejectedArguments: structuredClone(issue.context.rejectedArguments),
    expectedArguments: structuredClone(issue.context.schemaCorrection.expectedArguments),
    removedInputPath: issue.context.schemaCorrection.inputPath,
    removedPropertyName: issue.context.schemaCorrection.propertyName,
    inputSchema: structuredClone(selected.input_schema || {}),
  };

  body.system = schemaCorrectionInstruction(plan);
  body.messages = [{ role: 'user', content: 'Emit the corrected Tool Call now.' }];
  body.tools = [structuredClone(selected)];
  body.tool_choice = {
    type: 'tool',
    name: plan.toolName,
    disable_parallel_tool_use: true,
  };
  return {
    body,
    plan,
    diagnostics: {
      recoveryInstructionPlacement: 'system',
      recoveryContextMode: 'scoped',
      recoveryMode: plan.mode,
      recoveryOriginReason: plan.originReason,
      recoveryToolCount: 1,
      recoveryToolNames: [plan.toolName],
      recoveryToolChoice: plan.toolName,
      forcedToolChoice: true,
      parallelToolCallsDisabled: true,
      toolInputSchemaRecovery: true,
      targetedSchemaCorrection: true,
      rejectedToolName: plan.toolName,
      removedInputPath: plan.removedInputPath,
      removedPropertyName: plan.removedPropertyName,
    },
  };
}

function schemaCorrectionFailure(detail, plan, diagnostics = {}) {
  return {
    ok: false,
    reason: 'invalid_tool_input_schema',
    detail,
    retryable: false,
    diagnostics: {
      toolInputSchemaRecoveryAttempted: true,
      targetedSchemaCorrection: true,
      rejectedToolName: plan?.toolName || null,
      removedInputPath: plan?.removedInputPath || null,
      ...diagnostics,
    },
  };
}

export function validateClaudeCodeSchemaCorrectionRecovery(output, plan) {
  if (plan?.mode !== 'schema_correction') return { ok: true };
  const selected = recoveryCall(output, { maxAuxiliaryTextBytes: 0 });
  if (!selected.ok) return schemaCorrectionFailure(selected.reason, plan, { recoveryFailureReason: selected.reason });
  const call = selected.call;
  if (call.name !== plan.toolName) {
    return schemaCorrectionFailure('The schema-correction Recovery changed the Tool name.', plan, {
      recoveryFailureReason: 'forced_tool_name_mismatch',
      actualToolName: call.name || null,
    });
  }
  if (!isPlainObject(call.parsedArguments)) {
    return schemaCorrectionFailure('The schema-correction Recovery did not produce a JSON object.', plan, {
      recoveryFailureReason: 'invalid_claude_code_tool_input',
    });
  }
  const schemaValidation = validateAgainstToolSchema(
    { name: plan.toolName, input_schema: plan.inputSchema },
    call.parsedArguments,
  );
  if (!schemaValidation.ok) {
    return schemaCorrectionFailure(schemaValidation.detail, plan, {
      recoveryFailureReason: schemaValidation.reason,
      ...(schemaValidation.diagnostics || {}),
    });
  }
  if (!sameJsonValue(call.parsedArguments, plan.expectedArguments)) {
    return schemaCorrectionFailure('The schema-correction Recovery changed arguments other than the unsupported property.', plan, {
      recoveryFailureReason: 'schema_correction_argument_mismatch',
    });
  }
  return { ok: true };
}

function recoveryCall(output, {
  maxAuxiliaryTextBytes = 0,
  excessTextReason = 'forced_tool_recovery_has_text',
} = {}) {
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  if (calls.length !== 1) return invalid('forced_tool_call_missing');

  const auxiliaryText = typeof output?.finalText === 'string' ? output.finalText.trim() : '';
  const auxiliaryTextBytes = auxiliaryText ? Buffer.byteLength(auxiliaryText, 'utf8') : 0;
  const normalizedLimit = Number.isSafeInteger(maxAuxiliaryTextBytes) && maxAuxiliaryTextBytes >= 0
    ? maxAuxiliaryTextBytes
    : 0;
  const diagnostics = {
    recoveryAuxiliaryTextPresent: auxiliaryTextBytes > 0,
    recoveryAuxiliaryTextBytes: auxiliaryTextBytes,
    recoveryAuxiliaryTextLimitBytes: normalizedLimit,
  };
  if (auxiliaryTextBytes > normalizedLimit) {
    return terminalRecoveryFailure(
      excessTextReason,
      excessTextReason === 'forced_tool_recovery_has_text'
        ? 'The forced Tool Recovery produced visible text.'
        : 'The forced Tool Recovery produced more auxiliary text than allowed.',
      diagnostics,
    );
  }
  return { ok: true, call: calls[0], diagnostics };
}

function terminalRecoveryFailure(reason, detail = reason, diagnostics = undefined) {
  return {
    ok: false,
    reason,
    detail,
    retryable: false,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function validateClaudeCodeToolRecovery(output, plan) {
  const selected = recoveryCall(output, {
    maxAuxiliaryTextBytes: Number.isSafeInteger(plan?.maxAuxiliaryTextBytes) ? plan.maxAuxiliaryTextBytes : 1024,
    excessTextReason: 'forced_tool_recovery_excess_text',
  });
  if (!selected.ok) return selected;
  const call = selected.call;
  if (call.name !== plan.toolName) return terminalRecoveryFailure('forced_tool_name_mismatch', 'forced_tool_name_mismatch', selected.diagnostics);
  if (!isPlainObject(call.parsedArguments)) return terminalRecoveryFailure('invalid_claude_code_tool_input', 'invalid_claude_code_tool_input', selected.diagnostics);
  if (plan.inputSchema) {
    const schemaValidation = validateAgainstToolSchema(
      { name: plan.toolName, input_schema: plan.inputSchema },
      call.parsedArguments,
    );
    if (!schemaValidation.ok) return terminalRecoveryFailure(schemaValidation.reason, schemaValidation.detail, {
      ...selected.diagnostics,
      ...(schemaValidation.diagnostics || {}),
    });
  }
  const actualTarget = targetPathFor(call.name, call.parsedArguments);
  if (actualTarget !== plan.targetPath) return terminalRecoveryFailure('recovery_target_mismatch', 'recovery_target_mismatch', selected.diagnostics);

  if (plan.mode === 'read_target') return { ok: true, diagnostics: selected.diagnostics };

  if (call.name === TOOL_NAMES.EDIT) {
    if (typeof call.parsedArguments.old_string !== 'string' || typeof call.parsedArguments.new_string !== 'string') {
      return terminalRecoveryFailure('invalid_claude_code_tool_input', 'invalid_claude_code_tool_input', selected.diagnostics);
    }
    if (call.parsedArguments.old_string === call.parsedArguments.new_string) {
      return terminalRecoveryFailure('no_op_edit_tool_call', 'no_op_edit_tool_call', selected.diagnostics);
    }
    if (plan.rejectedArguments?.replace_all !== true && call.parsedArguments.replace_all === true) {
      return terminalRecoveryFailure('recovery_scope_widened', 'recovery_scope_widened', selected.diagnostics);
    }
  }

  const currentFingerprint = fingerprint(call.name, call.parsedArguments);
  if (plan.rejectedFingerprint && currentFingerprint === plan.rejectedFingerprint) {
    return terminalRecoveryFailure(repeatedReason(call.name), repeatedFailureMessage(call.name), selected.diagnostics);
  }
  return { ok: true, diagnostics: selected.diagnostics };
}

export const CLAUDE_CODE_TOOL_NAMES = TOOL_NAMES;
