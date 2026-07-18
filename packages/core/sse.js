export class SseFrameDecoder {
  #decoder = new TextDecoder();
  #pending = '';
  #finished = false;

  push(chunk) {
    if (this.#finished) throw new Error('SSE decoder already finished');
    if (typeof chunk === 'string') this.#pending += chunk;
    else if (chunk instanceof Uint8Array) this.#pending += this.#decoder.decode(chunk, { stream: true });
    else throw new TypeError('SSE chunk must be a string or Uint8Array');
    return this.#drain();
  }

  finish() {
    if (this.#finished) return [];
    this.#pending += this.#decoder.decode();
    const frames = this.#drain();
    this.#finished = true;
    if (this.#pending.trim()) {
      frames.push({ event: 'invalid', data: '', raw: this.#pending, incomplete: true });
      this.#pending = '';
    }
    return frames;
  }

  #drain() {
    const frames = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.#pending);
      if (!match) break;
      const raw = this.#pending.slice(0, match.index);
      const delimiter = match[0];
      this.#pending = this.#pending.slice(match.index + delimiter.length);
      const parsed = this.#parse(raw);
      if (parsed) frames.push(parsed);
    }
    return frames;
  }

  #parse(raw) {
    let event = 'message';
    const dataLines = [];
    let id;
    let retry;
    let hasField = false;
    for (const line of raw.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') { event = value; hasField = true; }
      else if (field === 'data') { dataLines.push(value); hasField = true; }
      else if (field === 'id') { id = value; hasField = true; }
      else if (field === 'retry') { retry = Number.parseInt(value, 10); hasField = true; }
    }
    if (!hasField || dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n'), raw, id, retry };
  }
}

export function encodeSseData(data, event = null) {
  const prefix = event ? `event: ${event}\n` : '';
  return `${prefix}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}
