/**
 * Progressive SSE text emission.
 * Manus often dumps large chat / chatDelta payloads at once.
 * Split into small pieces so OpenCode paints typewriter-style instead of one wall.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ProgressiveOpts = {
  /** Soft max chars per SSE chunk (default 18) */
  maxChunk?: number;
  /** Delay between chunks ms (default 12). 0 = no delay */
  delayMs?: number;
  /** If text is shorter than this, write in one shot */
  instantUnder?: number;
  /** Abort check between chunks */
  aborted?: () => boolean;
};

/**
 * Emit text as progressive pieces through `write`.
 * Prefer breaking on spaces / newlines so words aren't shredded badly.
 */
export async function emitProgressive(
  text: string,
  write: (piece: string) => Promise<void>,
  opts: ProgressiveOpts = {}
): Promise<void> {
  if (!text) return;
  const maxChunk = opts.maxChunk ?? 18;
  const delayMs = opts.delayMs ?? 12;
  const instantUnder = opts.instantUnder ?? 12;

  if (text.length <= instantUnder) {
    await write(text);
    return;
  }

  // Disable progressive if env off
  if (process.env.MANUS_PROGRESSIVE_STREAM === '0' || process.env.MANUS_PROGRESSIVE_STREAM === 'false') {
    await write(text);
    return;
  }

  let i = 0;
  while (i < text.length) {
    if (opts.aborted?.()) return;

    let end = Math.min(i + maxChunk, text.length);

    if (end < text.length) {
      // Prefer natural breaks: space, newline, punctuation
      const window = text.slice(i, Math.min(i + maxChunk + 12, text.length));
      const breakAt = findBreak(window, maxChunk);
      if (breakAt > 0) end = i + breakAt;
    }

    const piece = text.slice(i, end);
    if (piece) await write(piece);
    i = end;

    if (delayMs > 0 && i < text.length) {
      await sleep(delayMs);
    }
  }
}

function findBreak(window: string, prefer: number): number {
  // Search backwards from prefer for whitespace / punctuation
  const limit = Math.min(window.length, prefer + 8);
  for (let j = Math.min(prefer, window.length - 1); j >= Math.floor(prefer * 0.4); j--) {
    const c = window[j];
    if (c === ' ' || c === '\n' || c === '\t' || c === '.' || c === ',' || c === ';' || c === '!' || c === '?' || c === ':' || c === ')') {
      return j + 1;
    }
  }
  // CJK / no spaces — hard cut at prefer
  return Math.min(prefer, limit);
}
