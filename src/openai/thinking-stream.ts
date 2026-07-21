/**
 * Thinking / reasoning stream for OpenCode, AI SDK, vLLM.
 *
 * Default: reasoning_content only (vLLM / DeepSeek / OpenCode openai-compatible).
 * Do NOT send empty delta.content — OpenCode closes the reasoning phase on first content.
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

  get hasReasoning(): boolean {
    return this.accumulated.trim().length > 0;
  }

  markContentPhase(): void {
    this.contentPhase = true;
  }

  /**
   * Chunks for a thought delta.
   * OpenCode: choices[0].delta.reasoning_content → reasoning-delta parts.
   * Never include content:"" here — empty content closes reasoning in OpenCode.
   */
  thoughtChunks(
    base: { id: string; created: number; model: string },
    thoughtDelta: string
  ): object[] {
    if (!thoughtDelta || this.mode === 'off') return [];
    // If answer already started, still allow late reasoning fields (some clients accept)
    // but never inject <think> tags into content after content phase.
    this.accumulated += thoughtDelta;
    const out: object[] = [];

    const useRc =
      this.mode === 'both' || this.mode === 'reasoning_content';
    const useTags =
      (this.mode === 'both' || this.mode === 'content_tags') && !this.contentPhase;

    if (useRc) {
      // Primary field OpenCode / vLLM / DeepSeek expect
      const delta: Record<string, unknown> = {
        reasoning_content: thoughtDelta,
      };
      // Optional alias for SDKs that only read `reasoning` (not OpenCode default)
      if (this.mode === 'both' || process.env.MANUS_THINK_ALIAS === '1') {
        delta.reasoning = thoughtDelta;
      }
      out.push(makeChunk(base, delta));
      this.opened = true;
    }

    if (useTags) {
      let contentPiece = thoughtDelta;
      if (!this.opened) {
        this.opened = true;
        contentPiece = `<think>\n${thoughtDelta}`;
      }
      out.push(makeChunk(base, { content: contentPiece }));
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
      if (this.mode === 'both' || process.env.MANUS_THINK_ALIAS === '1') {
        message.reasoning = r;
      }
    }
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
