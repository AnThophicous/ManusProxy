import { getAvailableCredits, getUserInfo } from '../manus/client.ts';
import { listStoredAccounts, touchAccount, upsertAccount } from './store.ts';
import { clearAccountCache, listAccounts, resolveAccountId } from '../services/playwright.ts';
import { log } from '../cli/log-bus.ts';

export type CreditsSnapshot = {
  accountId: string;
  total: number;
  free: number;
  refresh: number;
  ok: boolean;
};

export async function readCredits(accountId: string): Promise<CreditsSnapshot> {
  const r = await getAvailableCredits(accountId);
  if (!r.ok) {
    return { accountId, total: 0, free: 0, refresh: 0, ok: false };
  }
  const b = r.body as {
    totalCredits?: number;
    freeCredits?: number;
    refreshCredits?: number;
  };
  return {
    accountId,
    total: Number(b.totalCredits ?? 0),
    free: Number(b.freeCredits ?? 0),
    refresh: Number(b.refreshCredits ?? 0),
    ok: true,
  };
}

export function creditsExhausted(snap: CreditsSnapshot): boolean {
  if (!snap.ok) return true;
  // Manus free tier can go negative when overdrawn
  return snap.total <= 0 && snap.free <= 0 && snap.refresh <= 0;
}

/**
 * Pick next ready account with credits, rotating from current.
 * Marks exhausted accounts in store notes.
 */
export async function rotateAccount(fromAccountId?: string | null): Promise<string | null> {
  const current = resolveAccountId(fromAccountId);
  const ids = new Set<string>([
    ...listStoredAccounts().map((a) => a.id),
    ...listAccounts(),
  ]);
  if (!ids.size) ids.add('default');

  const ordered = [...ids].sort();
  // start after current
  const start = ordered.indexOf(current);
  const sequence = [
    ...ordered.slice(start + 1),
    ...ordered.slice(0, start + 1),
  ];

  log.warn('ROTATE', 'credits', `checking rotation from ${current}`, { sequence });

  for (const id of sequence) {
    if (id === current) continue;
    try {
      await clearAccountCache(id);
      const user = await getUserInfo(id);
      if (!user.ok) {
        log.warn('ROTATE', id, 'auth fail, skip');
        continue;
      }
      const credits = await readCredits(id);
      if (creditsExhausted(credits)) {
        upsertAccount(id, {
          notes: `exhausted@${new Date().toISOString()} total=${credits.total}`,
        });
        log.warn('ROTATE', id, 'no credits', credits);
        continue;
      }
      touchAccount(id);
      log.ok('ROTATE', id, `switched · credits=${credits.total}`, credits);
      return id;
    } catch (err) {
      log.warn('ROTATE', id, err instanceof Error ? err.message : String(err));
    }
  }

  log.err('ROTATE', 'fail', 'no alternate account with credits');
  return null;
}

export async function ensureAccountWithCredits(
  preferred?: string | null
): Promise<{ accountId: string; credits: CreditsSnapshot; rotated: boolean }> {
  const start = resolveAccountId(preferred);
  let credits = await readCredits(start);
  if (!creditsExhausted(credits)) {
    return { accountId: start, credits, rotated: false };
  }
  log.warn('ROTATE', start, 'credits exhausted, rotating…', credits);
  const next = await rotateAccount(start);
  if (!next) {
    return { accountId: start, credits, rotated: false };
  }
  credits = await readCredits(next);
  return { accountId: next, credits, rotated: true };
}
