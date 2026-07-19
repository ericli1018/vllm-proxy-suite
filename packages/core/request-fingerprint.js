import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function fingerprintRequest(path, rawBody) {
  return createHash('sha256')
    .update(String(path || ''))
    .update('\0')
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || ''))
    .digest('hex');
}

export class RequestFingerprintRegistry {
  #entries = new Map();
  #ttlMs;
  #maxEntries;

  constructor({ ttlMs = 15 * 60 * 1000, maxEntries = 10000 } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  #prune(now = performance.now()) {
    for (const [fingerprint, entry] of this.#entries) {
      if (now - entry.observedAtMono > this.#ttlMs) this.#entries.delete(fingerprint);
    }
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  observe(fingerprint, requestId, now = performance.now()) {
    this.#prune(now);
    const previous = this.#entries.get(fingerprint) || null;
    const retryOrdinal = previous ? previous.retryOrdinal + 1 : 0;
    this.#entries.set(fingerprint, {
      fingerprint,
      requestId,
      observedAtMono: now,
      retryOrdinal,
      terminalEvent: null,
      terminalFields: null,
    });
    this.#prune(now);
    if (!previous) return null;
    return {
      previousRequestId: previous.requestId,
      previousTerminalEvent: previous.terminalEvent,
      previousTerminalFields: previous.terminalFields,
      retryDelayMs: Math.max(0, Math.round(now - previous.observedAtMono)),
      retryOrdinal,
    };
  }

  complete(fingerprint, requestId, terminalEvent, terminalFields = {}, now = performance.now()) {
    this.#prune(now);
    const entry = this.#entries.get(fingerprint);
    if (!entry || entry.requestId !== requestId) return false;
    entry.terminalEvent = terminalEvent;
    entry.terminalFields = {
      reason: terminalFields.reason ?? null,
      kind: terminalFields.kind ?? null,
      status: terminalFields.status ?? null,
      retryable: terminalFields.retryable ?? null,
    };
    entry.completedAtMono = now;
    return true;
  }

  get size() { return this.#entries.size; }
}
