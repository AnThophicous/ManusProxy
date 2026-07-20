import type { Context } from 'hono';
import {
  getDefaultAccountId,
  listStoredAccounts,
  publicAccountView,
  setDefaultAccountId,
  deleteAccount,
  upsertAccount,
} from '../account/store.ts';
import { listAccounts, getProfilePath } from '../services/playwright.ts';
import { fingerprintSecret } from '../account/crypto.ts';

export async function listAccountsRoute(c: Context) {
  const stored = listStoredAccounts().map(publicAccountView);
  const profiles = listAccounts();
  return c.json({
    defaultAccountId: getDefaultAccountId(),
    vaultKeyFingerprint: fingerprintSecret(),
    accounts: stored,
    profiles,
  });
}

export async function setDefaultAccountRoute(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const id = body.account || body.id || c.req.param('id');
  if (!id) {
    return c.json({ error: { message: 'account id required' } }, 400);
  }
  try {
    const def = setDefaultAccountId(String(id));
    return c.json({ ok: true, defaultAccountId: def });
  } catch (err) {
    return c.json(
      { error: { message: err instanceof Error ? err.message : String(err) } },
      400
    );
  }
}

export async function createAccountRoute(c: Context) {
  const body = await c.req.json().catch(() => ({}));
  const id = body.account || body.id;
  if (!id) {
    return c.json({ error: { message: 'account id required' } }, 400);
  }
  const acc = upsertAccount(String(id), {
    label: body.label,
    notes: body.notes,
  });
  return c.json({
    ok: true,
    account: publicAccountView(acc),
    profilePath: getProfilePath(acc.id),
    next: `npm run login -- --account=${acc.id}`,
  });
}

export async function deleteAccountRoute(c: Context) {
  const id = c.req.param('id')!;
  const ok = deleteAccount(id);
  if (!ok) return c.json({ error: { message: 'not found' } }, 404);
  return c.json({ ok: true, deleted: id });
}
