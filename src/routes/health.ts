import type { Context } from 'hono';
import { getCachedAuth, listAccounts } from '../services/playwright.ts';
import { getDefaultAccountId, listStoredAccounts, publicAccountView } from '../account/store.ts';
import { fingerprintSecret } from '../account/crypto.ts';
import { responseStore } from '../store/response-store.ts';

export async function health(c: Context) {
  responseStore.prune();
  const auth = getCachedAuth();
  return c.json({
    ok: true,
    service: 'manusproxy',
    version: '0.2.0',
    features: [
      'chat.completions',
      'chat.completions.stream',
      'responses',
      'responses.stream',
      'multi-account',
      'secure-vault',
      'images.data-url',
      'tool_calls',
      'session_reuse',
    ],
    defaultAccountId: getDefaultAccountId(),
    vaultKeyFingerprint: fingerprintSecret(),
    accounts: listStoredAccounts().map(publicAccountView),
    profiles: listAccounts(),
    authCached: Boolean(auth?.authorization || auth?.cookie),
    authAgeMs: auth ? Date.now() - auth.capturedAt : null,
  });
}
