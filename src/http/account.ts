import type { Context } from 'hono';
import { getDefaultAccountId } from '../account/store.ts';

export function accountFromRequest(
  c: Context,
  body?: { account?: string }
): string | undefined {
  const header =
    c.req.header('x-manus-account') ||
    c.req.header('x-account') ||
    c.req.query('account') ||
    undefined;
  if (header) return header;
  if (body?.account) return body.account;
  if (process.env.MANUS_ACCOUNT) return process.env.MANUS_ACCOUNT;
  try {
    return getDefaultAccountId();
  } catch {
    return undefined;
  }
}
