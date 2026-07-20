import fs from 'node:fs';
import path from 'node:path';
import { decryptJson, encryptJson, fingerprintSecret } from './crypto.ts';
import { getProfilePath, sanitizeAccountId } from '../services/playwright.ts';

export type StoredAccount = {
  id: string;
  label: string;
  profilePath: string;
  email?: string;
  displayName?: string;
  userId?: string;
  ready: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  lastUsedAt?: string;
  /** encrypted JWT cache (optional, short-lived convenience) */
  encryptedAuthBlob?: string;
  notes?: string;
};

type AccountStoreFile = {
  version: 2;
  encrypted: true;
  keyFingerprint: string;
  defaultAccountId: string;
  /** encrypted JSON of { accounts: Record<string, StoredAccount> } */
  payload: string;
};

type PlainPayload = {
  accounts: Record<string, StoredAccount>;
};

const ROOT = path.resolve('manus_profiles');
const STORE_PATH = path.join(ROOT, 'accounts.vault.json');
const LEGACY_PLAIN = path.join(ROOT, 'accounts.json');

function nowIso() {
  return new Date().toISOString();
}

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function emptyPlain(): PlainPayload {
  return { accounts: {} };
}

export function loadPlainAccounts(): {
  defaultAccountId: string;
  accounts: Record<string, StoredAccount>;
} {
  ensureRoot();

  // migrate plain legacy if present
  if (!fs.existsSync(STORE_PATH) && fs.existsSync(LEGACY_PLAIN)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_PLAIN, 'utf8')) as {
        defaultAccountId?: string;
        accounts?: Record<string, StoredAccount>;
      };
      const plain: PlainPayload = { accounts: legacy.accounts || {} };
      const defaultAccountId = legacy.defaultAccountId || 'default';
      saveVault(defaultAccountId, plain);
      fs.renameSync(LEGACY_PLAIN, `${LEGACY_PLAIN}.migrated.bak`);
      return { defaultAccountId, accounts: plain.accounts };
    } catch {
      /* fall through */
    }
  }

  if (!fs.existsSync(STORE_PATH)) {
    const plain = emptyPlain();
    saveVault('default', plain);
    return { defaultAccountId: 'default', accounts: {} };
  }

  try {
    const file = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as AccountStoreFile;
    const plain = decryptJson<PlainPayload>(file.payload);
    return {
      defaultAccountId: file.defaultAccountId || 'default',
      accounts: plain.accounts || {},
    };
  } catch (err) {
    console.error('[account-store] failed to decrypt vault — check MANUS_STORE_SECRET', err);
    throw new Error(
      'Não foi possível abrir o vault de contas. Verifique MANUS_STORE_SECRET / .store_key.'
    );
  }
}

function saveVault(defaultAccountId: string, plain: PlainPayload) {
  ensureRoot();
  const file: AccountStoreFile = {
    version: 2,
    encrypted: true,
    keyFingerprint: fingerprintSecret(),
    defaultAccountId,
    payload: encryptJson(plain),
  };
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* windows */
  }
}

export function listStoredAccounts(): StoredAccount[] {
  const { accounts } = loadPlainAccounts();
  return Object.values(accounts).sort((a, b) => a.id.localeCompare(b.id));
}

export function getDefaultAccountId(): string {
  return loadPlainAccounts().defaultAccountId || 'default';
}

export function setDefaultAccountId(accountId: string): string {
  const data = loadPlainAccounts();
  const id = sanitizeAccountId(accountId);
  if (!data.accounts[id]) {
    throw new Error(`Conta "${id}" não existe. Faça login: npm run login -- --account=${id}`);
  }
  saveVault(id, { accounts: data.accounts });
  return id;
}

export function upsertAccount(
  accountId: string,
  patch: Partial<StoredAccount> = {}
): StoredAccount {
  const data = loadPlainAccounts();
  const id = sanitizeAccountId(accountId);
  const profilePath = getProfilePath(id);
  fs.mkdirSync(profilePath, { recursive: true });

  const prev = data.accounts[id];
  const next: StoredAccount = {
    id,
    label: patch.label || prev?.label || id,
    profilePath,
    email: patch.email ?? prev?.email,
    displayName: patch.displayName ?? prev?.displayName,
    userId: patch.userId ?? prev?.userId,
    ready: patch.ready ?? prev?.ready ?? false,
    createdAt: prev?.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastLoginAt: patch.lastLoginAt ?? prev?.lastLoginAt,
    lastUsedAt: patch.lastUsedAt ?? prev?.lastUsedAt,
    encryptedAuthBlob: patch.encryptedAuthBlob ?? prev?.encryptedAuthBlob,
    notes: patch.notes ?? prev?.notes,
  };
  data.accounts[id] = next;
  let def = data.defaultAccountId;
  if (!def || !data.accounts[def]) def = id;
  saveVault(def, { accounts: data.accounts });
  return next;
}

export function markAccountReady(
  accountId: string,
  meta?: { email?: string; displayName?: string; userId?: string }
) {
  return upsertAccount(accountId, {
    ready: true,
    email: meta?.email,
    displayName: meta?.displayName,
    userId: meta?.userId,
    lastLoginAt: nowIso(),
  });
}

export function touchAccount(accountId: string) {
  return upsertAccount(accountId, { lastUsedAt: nowIso() });
}

export function deleteAccount(accountId: string): boolean {
  const data = loadPlainAccounts();
  const id = sanitizeAccountId(accountId);
  if (!data.accounts[id]) return false;
  delete data.accounts[id];
  let def = data.defaultAccountId;
  if (def === id) {
    def = Object.keys(data.accounts)[0] || 'default';
  }
  saveVault(def, { accounts: data.accounts });
  return true;
}

/** Public view — never leak encrypted blobs */
export function publicAccountView(a: StoredAccount) {
  return {
    id: a.id,
    label: a.label,
    email: a.email ? maskEmail(a.email) : undefined,
    displayName: a.displayName,
    ready: a.ready,
    lastLoginAt: a.lastLoginAt,
    lastUsedAt: a.lastUsedAt,
    createdAt: a.createdAt,
  };
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const u = user.length <= 2 ? '*'.repeat(user.length) : `${user[0]}***${user[user.length - 1]}`;
  return `${u}@${domain}`;
}

export function storeEncryptedAuth(accountId: string, authPayload: unknown) {
  return upsertAccount(accountId, {
    encryptedAuthBlob: encryptJson(authPayload),
  });
}

export function loadEncryptedAuth<T = unknown>(accountId: string): T | null {
  const data = loadPlainAccounts();
  const id = sanitizeAccountId(accountId);
  const blob = data.accounts[id]?.encryptedAuthBlob;
  if (!blob) return null;
  try {
    return decryptJson<T>(blob);
  } catch {
    return null;
  }
}
