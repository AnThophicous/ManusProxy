import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  // Help clients that sniff buffering
  'Transfer-Encoding': 'chunked',
} as const;

export interface SseWriter {
  write: (payload: unknown) => Promise<void>;
  writeData: (payload: unknown) => Promise<void>;
  writeEvent: (event: string, payload: unknown) => Promise<void>;
  writeDone: () => Promise<void>;
  writeComment: (text?: string) => Promise<void>;
  writeError: (message: string, type?: string, code?: string | null) => Promise<void>;
  aborted: () => boolean;
  onAbort: (cb: () => void) => void;
}

export class SequenceCounter {
  private n = 0;
  next(): number {
    return this.n++;
  }
}

export function applySseHeaders(c: Context): void {
  for (const [key, value] of Object.entries(SSE_HEADERS)) {
    c.header(key, value);
  }
}

export function createSseResponse(
  c: Context,
  handler: (writer: SseWriter) => Promise<void>
) {
  applySseHeaders(c);

  return honoStream(c, async (streamWriter) => {
    let aborted = false;
    const abortListeners: Array<() => void> = [];

    streamWriter.onAbort(() => {
      aborted = true;
      for (const cb of abortListeners) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });

    const writeRaw = async (chunk: string) => {
      if (aborted) return;
      await streamWriter.write(chunk);
    };

    const writer: SseWriter = {
      write: async (payload: unknown) => {
        await writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
      },
      writeData: async (payload: unknown) => {
        await writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
      },
      writeEvent: async (event: string, payload: unknown) => {
        await writeRaw(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      },
      writeDone: async () => {
        await writeRaw('data: [DONE]\n\n');
      },
      writeComment: async (text = 'ping') => {
        await writeRaw(`: ${text}\n\n`);
      },
      writeError: async (message: string, type = 'server_error', code: string | null = null) => {
        await writeRaw(
          `data: ${JSON.stringify({
            error: { message, type, param: null, code },
          })}\n\n`
        );
      },
      aborted: () => aborted,
      onAbort: (cb: () => void) => {
        abortListeners.push(cb);
      },
    };

    // Immediate first byte so proxies/clients don't buffer waiting
    await writer.writeComment('stream-open');

    const keepalive = setInterval(() => {
      void writer.writeComment('keepalive');
    }, 12_000);

    try {
      await handler(writer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message) || aborted) {
        await writer
          .write({
            error: {
              message: 'Request cancelled',
              type: 'cancelled',
              param: null,
              code: 'cancelled',
            },
          })
          .catch(() => {});
        await writer.writeDone().catch(() => {});
      } else {
        await writer.writeError(message);
        await writer.writeDone();
      }
    } finally {
      clearInterval(keepalive);
    }
  });
}

/** Default: stream unless explicitly false */
export function wantsStream(body: { stream?: boolean | null }): boolean {
  if (body.stream === false) return false;
  return true;
}
