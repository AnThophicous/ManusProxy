import { getDefaultAccountId, listStoredAccounts, touchAccount } from './store.ts';
import { resolveAccountId, sanitizeAccountId } from '../services/playwright.ts';

/** Round-robin cursor for multi-account load balancing */
let rrIndex = 0;

export function getPreferredAccount(forced?: string | null): string {
  if (forced && String(forced).trim()) {
    const id = sanitizeAccountId(forced);
    touchAccount(id);
    return id;
  }

  const ready = listStoredAccounts().filter((a) => a.ready);
  if (ready.length === 0) {
    return resolveAccountId(getDefaultAccountId());
  }

  // sticky default first if ready
  const def = getDefaultAccountId();
  const defHit = ready.find((a) => a.id === def);
  if (defHit) {
    touchAccount(defHit.id);
    return defHit.id;
  }

  const pick = ready[rrIndex % ready.length];
  rrIndex = (rrIndex + 1) % Math.max(ready.length, 1);
  touchAccount(pick.id);
  return pick.id;
}

export function listReadyAccountIds(): string[] {
  return listStoredAccounts()
    .filter((a) => a.ready)
    .map((a) => a.id);
}
