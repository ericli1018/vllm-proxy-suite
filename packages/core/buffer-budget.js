export class BufferBudget {
  #limit;
  #total = 0;
  #requests = new Map();

  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer');
    this.#limit = limit;
  }

  get limit() { return this.#limit; }
  get total() { return this.#total; }

  usedBy(requestId) {
    return this.#requests.get(String(requestId)) || 0;
  }

  reserve(requestId, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (bytes === 0) return true;
    if (this.#total + bytes > this.#limit) return false;
    const key = String(requestId);
    this.#requests.set(key, this.usedBy(key) + bytes);
    this.#total += bytes;
    return true;
  }

  release(requestId) {
    const key = String(requestId);
    const released = this.usedBy(key);
    if (released === 0) return 0;
    this.#requests.delete(key);
    this.#total = Math.max(0, this.#total - released);
    return released;
  }
}
