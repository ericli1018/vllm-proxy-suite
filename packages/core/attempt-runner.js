import { performance } from 'node:perf_hooks';

import { detectReasoningLoop } from './loop-detector.js';

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function timeoutPromise(ms, onTimeout) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('timeout'));
    }, ms);
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function detectFromTexts(texts, config) {
  for (const text of texts || []) {
    const loopInfo = detectReasoningLoop(text, config);
    if (loopInfo) return loopInfo;
  }
  return null;
}

async function readBoundedText(response, limit = 4096) {
  const text = await response.text().catch(() => '');
  return text.slice(0, limit);
}

function emptySemanticMetrics() {
  return {
    reasoningBytes: 0,
    contentBytes: 0,
    toolNameBytes: 0,
    toolArgumentBytes: 0,
    semanticBytes: 0,
    sseEvents: 0,
    toolCallCount: 0,
    toolCallIndexes: [],
    toolCallKeys: [],
    toolCallIds: [],
    toolNames: [],
    toolArgumentBytesByCall: {},
    toolArgumentFragmentsByCall: {},
    parallelToolCallsDetected: false,
    toolCalls: [],
    doneReceived: null,
    finishReason: null,
    finishReasonsByChoice: {},
    responseCompleted: null,
    responseFailed: null,
    responseStatus: null,
    messageStopped: null,
    stopReason: null,
    usagePromptTokens: null,
    usageCompletionTokens: null,
    usageTotalTokens: null,
  };
}

function withAdapterDiagnostics(adapter, result, validation) {
  if (!validation || validation.ok) return validation;
  const completion = adapter.completionDiagnostics?.(result) || {};
  return {
    ...validation,
    diagnostics: {
      ...completion,
      ...(validation.diagnostics || {}),
    },
  };
}

function getSemanticMetrics(adapter, snapshot, { allowLegacy = true } = {}) {
  const metrics = adapter.semanticMetrics?.(snapshot);
  if (!metrics) {
    const semanticBytes = allowLegacy ? (adapter.semanticProgress?.(snapshot) ?? 0) : 0;
    return { ...emptySemanticMetrics(), semanticBytes };
  }
  return { ...emptySemanticMetrics(), ...metrics };
}

function shouldCommitToolPassthrough(toolPassthrough, snapshot, semantic) {
  if (!toolPassthrough) return false;
  if (typeof toolPassthrough.shouldCommit === 'function') return Boolean(toolPassthrough.shouldCommit(snapshot, semantic));
  return semantic.toolCallCount > 0;
}

function retainedSemanticBytes(semantic) {
  const toolCalls = Array.isArray(semantic?.toolCalls) ? semantic.toolCalls : [];
  const retainedToolArgumentBytes = toolCalls.length > 0
    ? toolCalls.reduce((total, tool) => total + (Number.isFinite(Number(tool?.argumentRetainedBytes))
      ? Number(tool.argumentRetainedBytes)
      : Number(tool?.argumentBytes || 0)), 0)
    : Number(semantic?.toolArgumentBytes || 0);
  return Number(semantic?.reasoningBytes || 0)
    + Number(semantic?.contentBytes || 0)
    + Number(semantic?.toolNameBytes || 0)
    + retainedToolArgumentBytes;
}

export async function performBufferedAttempt({
  fetchImpl = globalThis.fetch,
  url,
  method = 'POST',
  headers,
  requestBody,
  streaming,
  adapter,
  config,
  requestId,
  bufferBudget,
  timeoutMs,
  clientSignal = null,
  observer = null,
  attemptNumber = 1,
  toolPassthrough = null,
}) {
  const controller = new AbortController();
  const onClientAbort = () => controller.abort('client_cancelled');
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  const totalTimeout = timeoutPromise(timeoutMs, () => controller.abort('generation_timeout'));

  const startedAtMono = performance.now();
  let currentState = null;
  let headersAtMono = null;
  let firstByteAtMono = null;
  let firstSemanticAtMono = null;
  let lastByteAtMono = startedAtMono;
  let lastSemanticAtMono = startedAtMono;
  let previousReportAtMono = startedAtMono;
  let previousReportBytes = 0;
  let upstreamBytes = 0;
  let upstreamChunks = 0;
  let semantic = emptySemanticMetrics();
  let rawBufferedBytes = 0;
  let concatAllocated = false;
  let toolPassthroughCommitted = false;
  let toolPassthroughStartedAtMono = null;
  let toolPassthroughBufferedBytes = 0;
  let toolPassthroughObservationError = null;

  const setState = (state, fields = {}) => {
    if (currentState === state && Object.keys(fields).length === 0) return;
    currentState = state;
    observer?.onState?.({ requestId, attempt: attemptNumber, state, ...fields });
  };
  setState('upstream_connecting');

  const reportProgress = () => {
    if (!observer?.onProgress) return;
    const now = performance.now();
    const elapsedMs = Math.max(1, now - startedAtMono);
    const recentElapsedMs = Math.max(1, now - previousReportAtMono);
    const pendingReplayBytes = currentState === 'response_replaying' ? rawBufferedBytes : 0;
    const parsedSemanticRetainedBytes = retainedSemanticBytes(semantic);
    const estimatedRequestMemoryBytes = rawBufferedBytes
      + (parsedSemanticRetainedBytes * 2)
      + (concatAllocated ? rawBufferedBytes : 0)
      + pendingReplayBytes;
    observer.onProgress({
      requestId,
      attempt: attemptNumber,
      state: currentState,
      elapsedMs: Math.round(elapsedMs),
      upstreamBytes,
      averageBytesPerSec: Math.round((upstreamBytes * 1000) / elapsedMs),
      streamElapsedMs: firstByteAtMono === null ? 0 : Math.round(Math.max(1, now - firstByteAtMono)),
      streamAverageBytesPerSec: firstByteAtMono === null ? 0 : Math.round((upstreamBytes * 1000) / Math.max(1, now - firstByteAtMono)),
      recentBytesPerSec: Math.round(((upstreamBytes - previousReportBytes) * 1000) / recentElapsedMs),
      upstreamChunks,
      sseEvents: semantic.sseEvents,
      reasoningBytes: semantic.reasoningBytes,
      contentBytes: semantic.contentBytes,
      toolNameBytes: semantic.toolNameBytes,
      toolArgumentBytes: semantic.toolArgumentBytes,
      semanticBytes: semantic.semanticBytes,
      semanticProgress: semantic.semanticBytes,
      toolCallCount: semantic.toolCallCount,
      toolCallIndexes: semantic.toolCallIndexes,
      toolCallKeys: semantic.toolCallKeys,
      toolCallIds: semantic.toolCallIds,
      toolNames: semantic.toolNames,
      toolArgumentBytesByCall: semantic.toolArgumentBytesByCall,
      toolArgumentFragmentsByCall: semantic.toolArgumentFragmentsByCall,
      parallelToolCallsDetected: semantic.parallelToolCallsDetected,
      toolCalls: semantic.toolCalls,
      doneReceived: semantic.doneReceived,
      finishReason: semantic.finishReason,
      finishReasonsByChoice: semantic.finishReasonsByChoice,
      responseCompleted: semantic.responseCompleted,
      responseFailed: semantic.responseFailed,
      responseStatus: semantic.responseStatus,
      messageStopped: semantic.messageStopped,
      stopReason: semantic.stopReason,
      usagePromptTokens: semantic.usagePromptTokens,
      usageCompletionTokens: semantic.usageCompletionTokens,
      usageTotalTokens: semantic.usageTotalTokens,
      toolPassthroughCommitted,
      toolPassthroughBufferedBytes,
      toolPassthroughElapsedMs: toolPassthroughStartedAtMono === null ? 0 : Math.round(Math.max(0, now - toolPassthroughStartedAtMono)),
      toolPassthroughObservationError,
      rawBufferedBytes,
      bufferedBytes: rawBufferedBytes,
      parsedSemanticBytes: semantic.semanticBytes,
      parsedSemanticRetainedBytes,
      estimatedRequestMemoryBytes,
      pendingReplayBytes,
      globalBufferedBytes: bufferBudget.total,
      globalBufferLimitBytes: bufferBudget.limit,
      globalBufferUtilization: bufferBudget.limit > 0 ? Number((bufferBudget.total / bufferBudget.limit).toFixed(6)) : 0,
      globalBufferUtilizationRatio: bufferBudget.limit > 0 ? Number((bufferBudget.total / bufferBudget.limit).toFixed(6)) : 0,
      globalBufferUtilizationPercent: bufferBudget.limit > 0 ? Number(((bufferBudget.total / bufferBudget.limit) * 100).toFixed(4)) : 0,
      lastUpstreamActivityMs: Math.round(now - lastByteAtMono),
      lastSemanticActivityMs: Math.round(now - lastSemanticAtMono),
      timeToHeadersMs: headersAtMono === null ? null : Math.round(headersAtMono - startedAtMono),
      timeToFirstByteMs: firstByteAtMono === null ? null : Math.round(firstByteAtMono - startedAtMono),
      timeToFirstSemanticMs: firstSemanticAtMono === null ? null : Math.round(firstSemanticAtMono - startedAtMono),
      semanticElapsedMs: firstSemanticAtMono === null ? 0 : Math.round(Math.max(0, now - firstSemanticAtMono)),
    });
    previousReportAtMono = now;
    previousReportBytes = upstreamBytes;
  };

  const progressTimer = observer?.onProgress && streaming
    ? setInterval(reportProgress, config.progressLogIntervalMs || 10000)
    : null;
  progressTimer?.unref?.();

  const abortCommittedDelivery = async (reason, error = null) => {
    if (!toolPassthroughCommitted) return;
    await toolPassthrough?.abort?.({ reason, error, requestId, attempt: attemptNumber }).catch(() => {});
  };

  try {
    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, { method, headers, body: requestBody, signal: controller.signal }),
        totalTimeout.promise,
      ]);
      headersAtMono = performance.now();
      lastByteAtMono = headersAtMono;
      lastSemanticAtMono = headersAtMono;
      setState('upstream_headers_received', { timeToHeadersMs: Math.round(headersAtMono - startedAtMono) });
    } catch (error) {
      if (clientSignal?.aborted) return { kind: 'cancelled', reason: 'client_cancelled' };
      return { kind: 'interrupted', reason: controller.signal.reason || 'upstream_fetch_failed', message: safeMessage(error) };
    }

    if (!response.ok) {
      return {
        kind: 'http_error',
        status: response.status,
        reason: 'upstream_http_error',
        message: await readBoundedText(response),
        headers: response.headers,
      };
    }

    const chunks = [];
    let bytes = 0;
    const reserve = (chunk) => {
      const size = chunk.byteLength;
      if (bytes + size > config.maxResponseBufferBytes) return 'response_buffer_limit';
      if (!bufferBudget.reserve(requestId, size)) return 'global_buffer_limit_exceeded';
      bytes += size;
      rawBufferedBytes = bytes;
      upstreamBytes += size;
      chunks.push(Buffer.from(chunk));
      return null;
    };

    if (!streaming) {
      setState('upstream_waiting_first_byte');
      const data = new Uint8Array(await response.arrayBuffer());
      firstByteAtMono = performance.now();
      lastByteAtMono = firstByteAtMono;
      upstreamChunks = data.byteLength > 0 ? 1 : 0;
      const violation = reserve(data);
      if (violation) return { kind: 'invalid', reason: violation };
      const rawBody = Buffer.concat(chunks);
      concatAllocated = true;
      let result;
      try {
        result = adapter.parseJson(rawBody, config);
      } catch (error) {
        return { kind: 'invalid', reason: 'invalid_json_response', message: safeMessage(error) };
      }
      semantic = getSemanticMetrics(adapter, result, { allowLegacy: false });
      if (semantic.semanticBytes > 0) {
        firstSemanticAtMono = performance.now();
        lastSemanticAtMono = firstSemanticAtMono;
      }
      setState('attempt_validating');
      if (shouldCommitToolPassthrough(toolPassthrough, result, semantic)) {
        return {
          kind: 'tool_passthrough',
          deliveryCommitted: false,
          rawBody,
          result,
          status: response.status,
          headers: response.headers,
          upstreamBytes,
          semanticMetrics: semantic,
          attemptNumber,
        };
      }
      const loopInfo = detectFromTexts(adapter.getJsonReasoning?.(result) || [], config);
      if (loopInfo) return { kind: 'loop', loopInfo, result };
      const validation = withAdapterDiagnostics(adapter, result, adapter.validateJson(result, config));
      if (!validation.ok) return { kind: 'invalid', ...validation, result };
      return { kind: 'success', rawBody, result, status: response.status, headers: response.headers };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream') || !response.body) {
      return { kind: 'invalid', reason: 'upstream_not_sse', message: await readBoundedText(response) };
    }

    const parser = adapter.createStreamParser(config);
    const reader = response.body.getReader();
    let lastSemanticBytes = 0;
    let lastSnapshot = parser.snapshot();
    setState('upstream_waiting_first_byte');

    while (true) {
      const remaining = Math.max(1, config.upstreamIdleTimeoutMs - (performance.now() - lastByteAtMono));
      const idleTimeout = timeoutPromise(remaining, () => controller.abort('upstream_idle_timeout'));
      let read;
      try {
        read = await Promise.race([reader.read(), idleTimeout.promise, totalTimeout.promise]);
      } catch (error) {
        await reader.cancel(controller.signal.reason || 'timeout').catch(() => {});
        const reason = controller.signal.reason || 'upstream_timeout';
        await abortCommittedDelivery(reason, error);
        return {
          kind: clientSignal?.aborted ? 'cancelled' : 'interrupted',
          reason: clientSignal?.aborted ? 'client_cancelled' : reason,
          message: safeMessage(error),
          deliveryCommitted: toolPassthroughCommitted,
          result: lastSnapshot,
        };
      } finally {
        idleTimeout.clear();
      }
      if (read.done) break;

      const now = performance.now();
      if (firstByteAtMono === null) firstByteAtMono = now;
      lastByteAtMono = now;
      upstreamChunks += 1;
      setState(toolPassthroughCommitted ? 'tool_passthrough_streaming' : 'upstream_streaming');

      if (toolPassthroughCommitted) {
        upstreamBytes += read.value.byteLength;
        try {
          await toolPassthrough.write?.(Buffer.from(read.value), {
            requestId,
            attempt: attemptNumber,
            status: response.status,
            headers: response.headers,
          });
        } catch (error) {
          controller.abort('tool_passthrough_write_failed');
          await reader.cancel('tool_passthrough_write_failed').catch(() => {});
          await abortCommittedDelivery('tool_passthrough_write_failed', error);
          return {
            kind: 'interrupted',
            reason: 'tool_passthrough_write_failed',
            message: safeMessage(error),
            deliveryCommitted: true,
            result: lastSnapshot,
          };
        }
        try {
          parser.push(read.value);
          lastSnapshot = parser.snapshot();
          semantic = getSemanticMetrics(adapter, lastSnapshot);
        } catch (error) {
          toolPassthroughObservationError ||= safeMessage(error);
        }
      } else {
        const violation = reserve(read.value);
        if (violation) {
          controller.abort(violation);
          await reader.cancel(violation).catch(() => {});
          return { kind: 'invalid', reason: violation };
        }

        try {
          parser.push(read.value);
        } catch (error) {
          controller.abort('stream_parse_error');
          await reader.cancel('stream_parse_error').catch(() => {});
          return { kind: 'invalid', reason: 'stream_parse_error', message: safeMessage(error) };
        }
        lastSnapshot = parser.snapshot();
        semantic = getSemanticMetrics(adapter, lastSnapshot);

        if (shouldCommitToolPassthrough(toolPassthrough, lastSnapshot, semantic)) {
          parser.enableToolPassthroughObservation?.(config.toolPassthroughObservationMaxBytes);
          lastSnapshot = parser.snapshot();
          semantic = getSemanticMetrics(adapter, lastSnapshot);
          const bufferedBody = Buffer.concat(chunks);
          concatAllocated = true;
          toolPassthroughBufferedBytes = bufferedBody.length;
          toolPassthroughStartedAtMono = performance.now();
          setState('tool_passthrough_committing', {
            toolCallCount: semantic.toolCallCount,
            bufferedBytes: bufferedBody.length,
          });
          toolPassthroughCommitted = true;
          try {
            await toolPassthrough.start?.({
              requestId,
              attempt: attemptNumber,
              status: response.status,
              headers: response.headers,
              bufferedBody,
              snapshot: lastSnapshot,
              semanticMetrics: semantic,
            });
          } catch (error) {
            controller.abort('tool_passthrough_start_failed');
            await reader.cancel('tool_passthrough_start_failed').catch(() => {});
            await abortCommittedDelivery('tool_passthrough_start_failed', error);
            bufferBudget.release(requestId);
            chunks.length = 0;
            bytes = 0;
            rawBufferedBytes = 0;
            concatAllocated = false;
            return {
              kind: 'interrupted',
              reason: 'tool_passthrough_start_failed',
              message: safeMessage(error),
              deliveryCommitted: true,
              result: lastSnapshot,
            };
          }
          bufferBudget.release(requestId);
          chunks.length = 0;
          bytes = 0;
          rawBufferedBytes = 0;
          concatAllocated = false;
          setState('tool_passthrough_streaming', {
            toolCallCount: semantic.toolCallCount,
            bufferedBytes: toolPassthroughBufferedBytes,
          });
        } else {
          const incremental = withAdapterDiagnostics(adapter, lastSnapshot, adapter.validateIncremental?.(lastSnapshot, config));
          if (incremental && !incremental.ok) {
            controller.abort(incremental.reason);
            await reader.cancel(incremental.reason).catch(() => {});
            return { kind: 'invalid', ...incremental, result: lastSnapshot };
          }
          const loopInfo = detectFromTexts(adapter.getReasoning(lastSnapshot) || [], config);
          if (loopInfo) {
            controller.abort(loopInfo.reason);
            await reader.cancel(loopInfo.reason).catch(() => {});
            return { kind: 'loop', loopInfo, result: lastSnapshot };
          }
        }
      }

      observer?.onChunk?.({
        requestId,
        attempt: attemptNumber,
        chunkBytes: read.value.byteLength,
        upstreamBytes,
        upstreamChunks,
        sseEvents: semantic.sseEvents,
        semanticBytes: semantic.semanticBytes,
        toolCallCount: semantic.toolCallCount,
        toolCallIndexes: semantic.toolCallIndexes,
        toolNames: semantic.toolNames,
        parallelToolCallsDetected: semantic.parallelToolCallsDetected,
        toolPassthroughCommitted,
      });
      if (semantic.semanticBytes !== lastSemanticBytes) {
        lastSemanticBytes = semantic.semanticBytes;
        lastSemanticAtMono = performance.now();
        if (firstSemanticAtMono === null && semantic.semanticBytes > 0) firstSemanticAtMono = lastSemanticAtMono;
      } else if (!toolPassthroughCommitted && performance.now() - lastSemanticAtMono >= config.semanticStallTimeoutMs) {
        controller.abort('semantic_stall_timeout');
        await reader.cancel('semantic_stall_timeout').catch(() => {});
        return { kind: 'invalid', reason: 'semantic_stall_timeout', result: lastSnapshot };
      }
    }

    let result = lastSnapshot;
    try {
      result = parser.finish();
    } catch (error) {
      if (!toolPassthroughCommitted) return { kind: 'invalid', reason: 'stream_finish_error', message: safeMessage(error) };
      toolPassthroughObservationError ||= safeMessage(error);
    }
    semantic = getSemanticMetrics(adapter, result);

    if (toolPassthroughCommitted) {
      try {
        await toolPassthrough.end?.({
          requestId,
          attempt: attemptNumber,
          status: response.status,
          headers: response.headers,
          result,
          semanticMetrics: semantic,
          observationError: toolPassthroughObservationError,
        });
      } catch (error) {
        await abortCommittedDelivery('tool_passthrough_end_failed', error);
        return {
          kind: 'interrupted',
          reason: 'tool_passthrough_end_failed',
          message: safeMessage(error),
          deliveryCommitted: true,
          result,
        };
      }
      setState('tool_passthrough_completed', {
        toolCallCount: semantic.toolCallCount,
        upstreamBytes,
      });
      return {
        kind: 'tool_passthrough',
        deliveryCommitted: true,
        result,
        status: response.status,
        headers: response.headers,
        upstreamBytes,
        semanticMetrics: semantic,
        bufferedBytesAtCommit: toolPassthroughBufferedBytes,
        observationError: toolPassthroughObservationError,
        attemptNumber,
      };
    }

    concatAllocated = true;
    setState('attempt_validating');
    const finalLoop = detectFromTexts(adapter.getReasoning(result) || [], config);
    if (finalLoop) return { kind: 'loop', loopInfo: finalLoop, result };
    const validation = withAdapterDiagnostics(adapter, result, adapter.validateStream(result, config));
    if (!validation.ok) return { kind: 'invalid', ...validation, result };
    return { kind: 'success', rawBody: Buffer.concat(chunks), result, status: response.status, headers: response.headers };
  } finally {
    totalTimeout.clear();
    if (progressTimer) clearInterval(progressTimer);
    if (observer?.onProgress) reportProgress();
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}
