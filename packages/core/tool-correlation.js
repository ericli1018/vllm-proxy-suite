import { performance } from 'node:perf_hooks';

export class ToolCallCorrelationRegistry {
  #entries = new Map();
  #ttlMs;
  #maxEntries;

  constructor({ ttlMs = 15 * 60 * 1000, maxEntries = 10000 } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  #prune(now = performance.now()) {
    for (const [id, entry] of this.#entries) {
      if (now - entry.deliveredAtMono > this.#ttlMs) this.#entries.delete(id);
    }
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  register(requestId, toolCalls, now = performance.now()) {
    this.#prune(now);
    for (const tool of toolCalls || []) {
      const id = tool?.id || tool?.call_id;
      if (!id) continue;
      this.#entries.set(String(id), {
        requestId,
        name: tool.name || tool.function?.name || null,
        deliveredAtMono: now,
      });
    }
    this.#prune(now);
  }

  resolve(toolResults, now = performance.now()) {
    this.#prune(now);
    const matches = [];
    for (const result of toolResults || []) {
      if (!result?.id) continue;
      const id = String(result.id);
      const entry = this.#entries.get(id);
      if (!entry) continue;
      matches.push({
        toolCallId: id,
        parentRequestId: entry.requestId,
        toolName: entry.name,
        roundTripMs: Math.max(0, Math.round(now - entry.deliveredAtMono)),
      });
      this.#entries.delete(id);
    }
    return matches;
  }

  get size() { return this.#entries.size; }
}
