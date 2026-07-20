import { chromium, firefox, webkit, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

export type ManusAuth = {
  cookie: string;
  authorization: string;
  userAgent: string;
  /** Extra headers seen on api.manus.im (device, session, etc.) */
  extras: Record<string, string>;
  capturedAt: number;
};

type AccountSession = {
  id: string;
  profilePath: string;
  context: BrowserContext;
  page: Page;
  auth: ManusAuth | null;
  mutex: Mutex;
};

const AUTH_TTL_MS = 15 * 60 * 1000;
const PROFILES_ROOT = path.resolve('manus_profiles');
const LEGACY_PROFILE = path.resolve('manus_profile');
const CAPTURE_DIR = path.resolve('capture');

let defaultAccountId = sanitizeAccountId(process.env.MANUS_ACCOUNT || 'default');
let defaultBrowserType: BrowserType = 'chrome';
let defaultHeadless = false;
const sessions = new Map<string, AccountSession>();

export let activePage: Page | null = null;

class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

export function sanitizeAccountId(raw: string): string {
  const cleaned = String(raw || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

export function resolveAccountId(input?: string | null): string {
  if (input && String(input).trim()) return sanitizeAccountId(input);
  return defaultAccountId;
}

export function getProfilePath(accountId: string): string {
  const id = sanitizeAccountId(accountId);
  if (
    id === 'default' &&
    fs.existsSync(LEGACY_PROFILE) &&
    !fs.existsSync(path.join(PROFILES_ROOT, 'default'))
  ) {
    return LEGACY_PROFILE;
  }
  return path.join(PROFILES_ROOT, id);
}

export function listAccounts(): string[] {
  const ids = new Set<string>();
  if (fs.existsSync(LEGACY_PROFILE)) ids.add('default');
  if (fs.existsSync(PROFILES_ROOT)) {
    for (const name of fs.readdirSync(PROFILES_ROOT, { withFileTypes: true })) {
      if (name.isDirectory()) ids.add(sanitizeAccountId(name.name));
    }
  }
  for (const id of sessions.keys()) ids.add(id);
  if (ids.size === 0) ids.add('default');
  return [...ids].sort();
}

function browserEngineFor(browserType: BrowserType) {
  let browserEngine: typeof chromium | typeof firefox | typeof webkit = chromium;
  let channel: string | undefined;
  switch (browserType) {
    case 'firefox':
      browserEngine = firefox;
      break;
    case 'webkit':
      browserEngine = webkit;
      break;
    case 'chrome':
      browserEngine = chromium;
      channel = 'chrome';
      break;
    case 'edge':
      browserEngine = chromium;
      channel = 'msedge';
      break;
    default:
      browserEngine = chromium;
  }
  return { browserEngine, channel };
}

function attachAuthCapture(session: AccountSession) {
  session.context.on('request', (request) => {
    const url = request.url();
    if (!url.includes('api.manus.im')) return;

    const headers = request.headers();
    const authorization = headers['authorization'] || '';
    const cookie = headers['cookie'] || '';
    if (!authorization && !cookie) return;

    const extras: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (
        k.startsWith('x-') ||
        k === 'connect-protocol-version' ||
        k === 'content-type' ||
        k === 'origin' ||
        k === 'referer'
      ) {
        extras[k] = v;
      }
    }

    session.auth = {
      cookie,
      authorization,
      userAgent: headers['user-agent'] || session.auth?.userAgent || '',
      extras,
      capturedAt: Date.now(),
    };
  });
}

async function launchAccount(
  accountId: string,
  headless: boolean,
  browserType: BrowserType
): Promise<AccountSession> {
  const id = sanitizeAccountId(accountId);
  const profilePath = getProfilePath(id);
  fs.mkdirSync(profilePath, { recursive: true });

  const { browserEngine, channel } = browserEngineFor(browserType);
  const args: string[] = [];
  const ignoreDefaultArgs: string[] = [];
  if (browserType === 'chromium' || browserType === 'chrome' || browserType === 'edge') {
    args.push('--disable-blink-features=AutomationControlled');
    ignoreDefaultArgs.push('--enable-automation');
  }

  console.log(`[Playwright] Launching ${browserType} account="${id}" headless=${headless}`);
  console.log(`[Playwright] Profile: ${profilePath}`);

  const context = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    args,
    ignoreDefaultArgs,
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  const session: AccountSession = {
    id,
    profilePath,
    context,
    page,
    auth: null,
    mutex: new Mutex(),
  };
  attachAuthCapture(session);
  sessions.set(id, session);
  if (id === defaultAccountId) activePage = page;
  return session;
}

export async function initPlaywright(
  headless = false,
  browserType: BrowserType = 'chrome',
  accountId?: string
) {
  defaultHeadless = headless;
  defaultBrowserType = browserType;
  const id = resolveAccountId(accountId);
  defaultAccountId = id;
  if (sessions.has(id)) {
    activePage = sessions.get(id)!.page;
    return;
  }
  const session = await launchAccount(id, headless, browserType);
  activePage = session.page;
}

export async function ensureAccount(
  accountId?: string | null,
  opts?: { headless?: boolean; browserType?: BrowserType }
): Promise<AccountSession> {
  const id = resolveAccountId(accountId);
  const existing = sessions.get(id);
  if (existing) return existing;
  return launchAccount(
    id,
    opts?.headless ?? defaultHeadless,
    opts?.browserType ?? defaultBrowserType
  );
}

export async function clearAccountCache(accountId?: string | null) {
  const id = resolveAccountId(accountId);
  const session = sessions.get(id);
  if (!session) return;
  session.auth = null;
}

export async function closeAccount(accountId?: string | null) {
  const id = resolveAccountId(accountId);
  const session = sessions.get(id);
  if (!session) return;
  await session.context.close().catch(() => {});
  sessions.delete(id);
  if (activePage === session.page) activePage = null;
}

export async function closePlaywright() {
  for (const id of [...sessions.keys()]) {
    await closeAccount(id);
  }
  activePage = null;
}

export async function getCookies(accountId?: string | null): Promise<string> {
  const session = await ensureAccount(accountId);
  const list = await session.context.cookies();
  const filtered = list.filter(
    (c) => c.domain.includes('manus') || c.domain.includes('butterfly')
  );
  const use = filtered.length ? filtered : list;
  return use.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function extractAuthFromPage(page: Page): Promise<{
  authorization: string;
  storageHints: string[];
}> {
  return page.evaluate(() => {
    const storageHints: string[] = [];
    let authorization = '';

    const consider = (source: string, k: string, v: string) => {
      if (!v) return;
      if (/token|auth|jwt|session|access|id_token|bearer/i.test(k) || /eyJ[A-Za-z0-9_-]+\./.test(v)) {
        storageHints.push(`${source}:${k}=${v.slice(0, 120)}`);
      }
      // JWT-looking values
      if (!authorization && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v.trim())) {
        authorization = v.trim().startsWith('Bearer ') ? v.trim() : `Bearer ${v.trim()}`;
      }
      // JSON blobs with access_token / token
      if (!authorization && (v.startsWith('{') || v.startsWith('['))) {
        try {
          const parsed = JSON.parse(v) as Record<string, unknown>;
          const pick =
            parsed.access_token ||
            parsed.accessToken ||
            parsed.token ||
            parsed.id_token ||
            parsed.idToken ||
            (parsed.data as Record<string, unknown> | undefined)?.token ||
            (parsed.data as Record<string, unknown> | undefined)?.access_token;
          if (typeof pick === 'string' && pick.length > 10) {
            authorization = pick.startsWith('Bearer ') ? pick : `Bearer ${pick}`;
          }
        } catch {
          /* ignore */
        }
      }
    };

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      consider('local', k, localStorage.getItem(k) || '');
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k) continue;
      consider('session', k, sessionStorage.getItem(k) || '');
    }

    return { authorization, storageHints };
  });
}

export async function getManusAuth(
  accountId?: string | null,
  forceRefresh = false
): Promise<ManusAuth> {
  const session = await ensureAccount(accountId);
  const release = await session.mutex.acquire();
  try {
    if (
      !forceRefresh &&
      session.auth &&
      session.auth.authorization &&
      Date.now() - session.auth.capturedAt < AUTH_TTL_MS
    ) {
      return session.auth;
    }

    const page = session.page;

    // Clear stale partial auth so we re-capture
    if (forceRefresh) {
      session.auth = null;
    }

    await page.goto('https://manus.im/app', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(async () => {
      await page.goto('https://manus.im/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    });

    // Wait up to 45s for an authenticated api.manus.im request
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (session.auth?.authorization) return session.auth;
      await page.waitForTimeout(400);
    }

    // Fallback: cookies + storage
    const cookie = await getCookies(session.id);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const fromPage = await extractAuthFromPage(page).catch(() => ({
      authorization: '',
      storageHints: [] as string[],
    }));

    // Also scan cookie values for JWT
    let authorization = session.auth?.authorization || fromPage.authorization || '';
    if (!authorization && cookie) {
      for (const part of cookie.split(';')) {
        const val = part.split('=').slice(1).join('=').trim();
        if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(val)) {
          authorization = `Bearer ${val}`;
          break;
        }
      }
    }

    if (!authorization && !cookie) {
      throw new Error(
        `Sem sessão Manus em account="${session.id}". Rode: npm run login -- --account=${session.id}\n` +
          `storage hints: ${fromPage.storageHints.join(' | ') || '(none)'}`
      );
    }

    if (!authorization) {
      console.warn(
        `[Playwright] Sem Authorization ainda (account=${session.id}). cookies ok=${cookie.length > 0}. hints=${fromPage.storageHints.join(' | ') || '(none)'}`
      );
    }

    session.auth = {
      cookie: session.auth?.cookie || cookie,
      authorization,
      userAgent: session.auth?.userAgent || userAgent,
      extras: session.auth?.extras || {
        origin: 'https://manus.im',
        referer: 'https://manus.im/',
      },
      capturedAt: Date.now(),
    };
    return session.auth;
  } finally {
    release();
  }
}

export function getCachedAuth(accountId?: string | null): ManusAuth | null {
  const id = resolveAccountId(accountId);
  return sessions.get(id)?.auth ?? null;
}

export async function saveCaptureDump(
  label: string,
  data: unknown,
  accountId?: string | null
) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const id = resolveAccountId(accountId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(CAPTURE_DIR, `${stamp}_${id}_${label}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[capture] wrote ${file}`);
  return file;
}

function isManusAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('manus.im')) return false;
    if (u.pathname.startsWith('/login')) return false;
    if (u.pathname.startsWith('/oauth') || u.pathname.includes('oauth')) return false;
    // App surfaces (avoid matching marketing-only root forever)
    if (
      u.pathname.startsWith('/app') ||
      u.pathname.startsWith('/home') ||
      u.pathname.startsWith('/chat') ||
      u.pathname.startsWith('/session') ||
      u.pathname.startsWith('/projects') ||
      u.pathname.startsWith('/tasks') ||
      u.pathname.startsWith('/work') ||
      u.pathname.startsWith('/space')
    ) {
      return true;
    }
    // Logged-in root sometimes is just / or /en after auth
    return false;
  } catch {
    return false;
  }
}

export async function waitForLogin(
  accountId?: string | null,
  timeoutMs = 10 * 60 * 1000
): Promise<boolean> {
  const session = await ensureAccount(accountId);
  const page = session.page;
  const deadline = Date.now() + timeoutMs;

  console.log('[login] Aguardando você entrar (email/Google + Turnstile)…');
  console.log('[login] Quando logar e cair no app, eu detecto sozinho.');

  while (Date.now() < deadline) {
    const url = page.url();

    // Never treat Google / third-party OAuth as success
    if (
      url.includes('accounts.google.com') ||
      url.includes('login.microsoftonline.com') ||
      url.includes('appleid.apple.com') ||
      url.includes('facebook.com') ||
      url.includes('challenges.cloudflare.com')
    ) {
      await page.waitForTimeout(1500);
      continue;
    }

    // Strong signal: intercepted Authorization on api.manus.im
    if (session.auth?.authorization) {
      console.log(`[login] Auth header capturado · url=${url}`);
      return true;
    }

    if (isManusAppUrl(url) || (url.includes('manus.im') && !url.includes('/login'))) {
      await page.waitForTimeout(1500);

      // Probe cookies that look like session
      const cookies = await session.context.cookies();
      const sessionish = cookies.filter((c) =>
        /session|token|auth|jwt|sid|access|manus/i.test(c.name)
      );

      // Try app route to force authenticated API calls
      if (!isManusAppUrl(page.url())) {
        await page
          .goto('https://manus.im/app', { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => {});
        await page.waitForTimeout(2000);
      }

      if (page.url().includes('/login')) {
        await page.waitForTimeout(1000);
        continue;
      }

      // Wait briefly for request interceptor to catch Authorization
      for (let i = 0; i < 15; i++) {
        if (session.auth?.authorization) {
          console.log(`[login] Sessão OK (Authorization) · url=${page.url()}`);
          return true;
        }
        await page.waitForTimeout(400);
      }

      // Fallback: session-like cookies on manus domain after leaving login
      const manusCookies = cookies.filter(
        (c) => c.domain.includes('manus.im') || c.domain.includes('manus')
      );
      if (
        sessionish.length > 0 ||
        manusCookies.some((c) => c.name.length > 3 && c.value.length > 20)
      ) {
        // Soft confirm: UserInfo would be better, but keep wait loop pure
        console.log(
          `[login] Sessão provável (cookies) · url=${page.url()} · cookies=${manusCookies.map((c) => c.name).join(',')}`
        );
        return true;
      }
    }

    await page.waitForTimeout(1500);
  }
  return false;
}
