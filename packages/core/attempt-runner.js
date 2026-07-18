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
}) {
  const controller = new AbortController();
  const onClientAbort = () => controller.abort('client_cancelled');
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });
  const totalTimeout = timeoutPromise(timeoutMs, () => controller.abort('generation_timeout'));

  try {
    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, { method, headers, body: requestBody, signal: controller.signal }),
        totalTimeout.promise,
      ]);
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
      chunks.push(Buffer.from(chunk));
      return null;
    };

    if (!streaming) {
      const data = new Uint8Array(await response.arrayBuffer());
      const violation = reserve(data);
      if (violation) return { kind: 'invalid', reason: violation };
      let result;
      try {
        result = adapter.parseJson(Buffer.concat(chunks), config);
      } catch (error) {
        return { kind: 'invalid', reason: 'invalid_json_response', message: safeMessage(error) };
      }
      const loopInfo = detectFromTexts(adapter.getJsonReasoning?.(result) || [], config);
      if (loopInfo) return { kind: 'loop', loopInfo, result };
      const validation = adapter.validateJson(result, config);
      if (!validation.ok) return { kind: 'invalid', ...validation, result };
      return { kind: 'success', rawBody: Buffer.concat(chunks), result, status: response.status, headers: response.headers };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream') || !response.body) {
      return { kind: 'invalid', reason: 'upstream_not_sse', message: await readBoundedText(response) };
    }

    const parser = adapter.createStreamParser(config);
    const reader = response.body.getReader();
    let lastByteAt = Date.now();
    let lastSemanticAt = Date.now();
    let lastSemanticProgress = 0;

    while (true) {
      const remaining = Math.max(1, config.upstreamIdleTimeoutMs - (Date.now() - lastByteAt));
      const idleTimeout = timeoutPromise(remaining, () => controller.abort('upstream_idle_timeout'));
      let read;
      try {
        read = await Promise.race([reader.read(), idleTimeout.promise, totalTimeout.promise]);
      } catch (error) {
        await reader.cancel(controller.signal.reason || 'timeout').catch(() => {});
        return { kind: 'interrupted', reason: controller.signal.reason || 'upstream_timeout', message: safeMessage(error) };
      } finally {
        idleTimeout.clear();
      }
      if (read.done) break;
      lastByteAt = Date.now();
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
      const snapshot = parser.snapshot();
      const incremental = adapter.validateIncremental?.(snapshot, config);
      if (incremental && !incremental.ok) {
        controller.abort(incremental.reason);
        await reader.cancel(incremental.reason).catch(() => {});
        return { kind: 'invalid', ...incremental, result: snapshot };
      }
      const loopInfo = detectFromTexts(adapter.getReasoning(snapshot) || [], config);
      if (loopInfo) {
        controller.abort(loopInfo.reason);
        await reader.cancel(loopInfo.reason).catch(() => {});
        return { kind: 'loop', loopInfo, result: snapshot };
      }
      const progress = adapter.semanticProgress?.(snapshot) ?? bytes;
      if (progress !== lastSemanticProgress) {
        lastSemanticProgress = progress;
        lastSemanticAt = Date.now();
      } else if (Date.now() - lastSemanticAt >= config.semanticStallTimeoutMs) {
        controller.abort('semantic_stall_timeout');
        await reader.cancel('semantic_stall_timeout').catch(() => {});
        return { kind: 'invalid', reason: 'semantic_stall_timeout', result: snapshot };
      }
    }

    let result;
    try {
      result = parser.finish();
    } catch (error) {
      return { kind: 'invalid', reason: 'stream_finish_error', message: safeMessage(error) };
    }
    const finalLoop = detectFromTexts(adapter.getReasoning(result) || [], config);
    if (finalLoop) return { kind: 'loop', loopInfo: finalLoop, result };
    const validation = adapter.validateStream(result, config);
    if (!validation.ok) return { kind: 'invalid', ...validation, result };
    return { kind: 'success', rawBody: Buffer.concat(chunks), result, status: response.status, headers: response.headers };
  } finally {
    totalTimeout.clear();
    clientSignal?.removeEventListener('abort', onClientAbort);
  }
}
