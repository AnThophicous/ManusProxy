/**
 * Registry of in-flight generations so we can cancel by response/completion id
 * (client disconnect OR explicit POST /v1/responses/:id/cancel).
 */

export type ActiveRun = {
  id: string;
  kind: 'chat' | 'response';
  accountId: string;
  manusSessionId: string | null;
  abort: AbortController;
  startedAt: number;
  /** optional: send stop to Manus */
  stopManus?: () => Promise<void> | void;
};

const runs = new Map<string, ActiveRun>();

export function registerRun(run: ActiveRun): void {
  runs.set(run.id, run);
}

export function unregisterRun(id: string): void {
  runs.delete(id);
}

export function getRun(id: string): ActiveRun | undefined {
  return runs.get(id);
}

export function listRuns(): ActiveRun[] {
  return [...runs.values()];
}

export async function cancelRun(
  id: string,
  reason = 'client_cancel'
): Promise<{ ok: boolean; found: boolean; reason: string }> {
  const run = runs.get(id);
  if (!run) return { ok: false, found: false, reason };
  try {
    await run.stopManus?.();
  } catch (err) {
    console.warn('[active-runs] stopManus failed', err);
  }
  if (!run.abort.signal.aborted) {
    run.abort.abort(reason);
  }
  runs.delete(id);
  return { ok: true, found: true, reason };
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    if (/abort/i.test(err.message)) return true;
  }
  return false;
}
