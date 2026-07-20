/**
 * Thinking / reasoning stream for OpenCode, AI SDK, vLLM.
 *
 * Default: reasoning_content only (clean for agents that render a think panel).
 * content_tags puts <think> in delta.content — only BEFORE any answer content.
 *
 * Env MANUS_THINK_MODE:
 *   reasoning_content | both | content_tags | off
 */

export type ThinkMode = 'both' | 'reasoning_content' | 'content_tags' | 'off';

export function resolveThinkMode(): ThinkMode {
  const raw = (process.env.MANUS_THINK_MODE || 'reasoning_content').toLowerCase();
  if (raw === 'both' || raw === 'all') return 'both';
  if (raw === 'content' || raw === 'content_tags' || raw === 'tags') return 'content_tags';
  if (raw === 'off' || raw === 'none' || raw === '0') return 'off';
  return 'reasoning_content';
}

export class ThinkingStreamBridge {
  private mode: ThinkMode;
  private opened = false;
  private closed = false;
  private contentPhase = false; // true once answer content started
  private accumulated = '';

  constructor(mode?: ThinkMode) {
    this.mode = mode ?? resolveThinkMode();
  }

  get reasoning(): string {
    return this.accumulated;
  }

  markContentPhase(): void {
    this.contentPhase = true;
  }

  /**
   * Chunks for a thought delta. Never injects <think> after content started.
   */
  thoughtChunks(
    base: { id: string; created: number; model: string },
    thoughtDelta: string
  ): object[] {
    if (!thoughtDelta || this.mode === 'off') return [];
    this.accumulated += thoughtDelta;
    const out: object[] = [];

    const useRc =
      this.mode === 'both' || this.mode === 'reasoning_content';
    // Tags only if we haven't entered answer phase yet
    const useTags =
      (this.mode === 'both' || this.mode === 'content_tags') && !this.contentPhase;

    if (useRc) {
      out.push(makeChunk(base, {
        reasoning_content: thoughtDelta,
        reasoning: thoughtDelta,
      }));
    }

    if (useTags) {
      let contentPiece = thoughtDelta;
      if (!this.opened) {
        this.opened = true;
        contentPiece = `<think>\n${thoughtDelta}`;
      }
      out.push(makeChunk(base, { content: contentPiece }));
    } else if (useRc) {
      this.opened = true;
    }

    return out;
  }

  /** Close </think> before answer — only if tags were opened and not closed */
  closeThinkTags(base: {
    id: string;
    created: number;
    model: string;
  }): object | null {
    if (this.closed) return null;
    const useTags =
      (this.mode === 'both' || this.mode === 'content_tags') && this.opened && !this.contentPhase;
    this.closed = true;
    this.contentPhase = true;
    if (!useTags) return null;
    return makeChunk(base, { content: '\n</think>\n' });
  }

  applyToMessage<T extends {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
  }>(message: T): T {
    const r = this.accumulated.trim();
    if (!r || this.mode === 'off') return message;

    if (this.mode === 'both' || this.mode === 'reasoning_content') {
      message.reasoning_content = r;
      message.reasoning = r;
    }
    // Don't wrap content with tags in non-stream for OpenCode — use field only
    // (avoids raw <think> in final message UI)
    return message;
  }
}

function makeChunk(
  base: { id: string; created: number; model: string },
  delta: Record<string, unknown>
): object {
  return {
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

/** Strip accidental think tags from Manus answer content */
export function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?thinking>/gi, '')
    .trim();
}
