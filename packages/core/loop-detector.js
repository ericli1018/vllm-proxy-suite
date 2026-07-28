function isCodeFence(text) {
  return /```|~~~/.test(text);
}

function isLogLine(line) {
  return /^\s*(?:\[[A-Z][A-Z0-9_-]*\]|\d{4}-\d{2}-\d{2}[T ][0-9:.-]+|(?:INFO|WARN|ERROR|DEBUG|TRACE)\b)/i.test(line);
}

function looksLikeCodeOrLogs(text) {
  if (isCodeFence(text)) return true;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length >= 2 && lines.filter(isLogLine).length / lines.length >= 0.6) return true;
  const codeSignals = lines.filter((line) => /[{};]|^\s*(?:const|let|var|function|class|if|for|while|return|import|export|#include|SELECT|INSERT|UPDATE)\b/.test(line));
  return lines.length >= 3 && codeSignals.length / lines.length >= 0.6;
}

function normalizeWithMap(text) {
  let normalized = '';
  const map = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    const lower = char.toLocaleLowerCase();
    if (/\p{L}|\p{N}/u.test(lower)) {
      normalized += lower;
      map.push(index);
    }
    index += char.length;
  }
  return { normalized, map };
}

function rawIndex(mapping, normalizedIndex, fallback) {
  if (normalizedIndex <= 0) return 0;
  return mapping.map[normalizedIndex] ?? fallback;
}


function detectExactSuffixRepeat(text, config) {
  const minSize = Math.max(4, config.loopMinPatternSize ?? 24);
  const minCount = Math.max(2, config.loopMinCount ?? 3);
  const maxSize = Math.min(config.loopMaxPatternSize ?? 2048, Math.floor(text.length / 2));
  for (let size = maxSize; size >= minSize; size -= 1) {
    const lastStart = text.length - size;
    const previousStart = lastStart - size;
    if (previousStart < 0) continue;
    const pattern = text.slice(lastStart);
    if (text.slice(previousStart, lastStart) !== pattern) continue;
    let count = 2;
    let cycleStart = previousStart;
    while (cycleStart - size >= 0 && text.slice(cycleStart - size, cycleStart) === pattern) {
      cycleStart -= size;
      count += 1;
    }
    if (count < minCount) continue;
    return {
      reason: 'repeated_reasoning_segment',
      cycleStart,
      cycleLength: size,
      retainEnd: cycleStart + size,
      repeatCount: count,
    };
  }
  return null;
}

function detectAbabLines(text, config) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const minCount = Math.max(2, config.loopMinCount ?? 3);
  if (lines.length < minCount * 2) return null;
  for (let i = 0; i <= lines.length - (minCount * 2); i += 1) {
    const a = lines[i];
    const b = lines[i + 1];
    if (a === b || a.length + b.length < 8) continue;
    let count = 1;
    let cursor = i + 2;
    while (cursor + 1 < lines.length && lines[cursor] === a && lines[cursor + 1] === b) {
      count += 1;
      cursor += 2;
    }
    if (count < minCount) continue;
    return {
      reason: 'abab_reasoning_lines',
      cycleStart: 0,
      cycleLength: a.length + b.length,
      retainEnd: a.length + b.length,
      repeatCount: count,
    };
  }
  return null;
}

export function detectReasoningLoop(text, config) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (looksLikeCodeOrLogs(text)) return null;

  const abab = detectAbabLines(text, config);
  if (abab) return abab;

  const exact = detectExactSuffixRepeat(text, config);
  if (exact) return exact;

  const mapping = normalizeWithMap(text);
  const normalized = mapping.normalized;
  const minSize = Math.max(4, config.loopMinPatternSize ?? 24);
  const minCount = Math.max(2, config.loopMinCount ?? 3);
  const maxSize = Math.min(config.loopMaxPatternSize ?? 2048, Math.floor(normalized.length / minCount));

  for (let size = maxSize; size >= minSize; size -= 1) {
    const lastStart = normalized.length - size;
    const previousStart = lastStart - size;
    if (previousStart < 0) continue;
    const pattern = normalized.slice(lastStart);
    if (normalized.slice(previousStart, lastStart) !== pattern) continue;

    let count = 2;
    let cycleStartNormalized = previousStart;
    while (cycleStartNormalized - size >= 0 && normalized.slice(cycleStartNormalized - size, cycleStartNormalized) === pattern) {
      cycleStartNormalized -= size;
      count += 1;
    }
    if (count < minCount) continue;
    const cycleStart = rawIndex(mapping, cycleStartNormalized, text.length);
    const retainEnd = rawIndex(mapping, cycleStartNormalized + size, text.length);
    const secondEnd = rawIndex(mapping, cycleStartNormalized + size * 2, text.length);
    const first = text.slice(cycleStart, retainEnd).replace(/\s+$/u, '');
    const second = text.slice(retainEnd, secondEnd).replace(/^\s+/u, '');
    return {
      reason: first === second ? 'repeated_reasoning_segment' : 'normalized_reasoning_segment',
      cycleStart,
      cycleLength: size,
      retainEnd,
      repeatCount: count,
    };
  }

  if (normalized.length >= (config.loopReasoningCharLimit ?? 24000)) {
    return {
      reason: 'reasoning_without_action',
      cycleStart: 0,
      cycleLength: normalized.length,
      retainEnd: Math.min(text.length, config.loopReasoningCharLimit ?? 24000),
      repeatCount: 1,
    };
  }
  return null;
}
