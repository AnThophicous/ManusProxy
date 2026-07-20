import * as dotenv from 'dotenv';
import {
  closePlaywright,
  getManusAuth,
  getProfilePath,
  initPlaywright,
  resolveAccountId,
  saveCaptureDump,
  waitForLogin,
  type BrowserType,
} from './services/playwright.ts';
import { getAvailableCredits, getUserInfo } from './manus/client.ts';
import {
  markAccountReady,
  storeEncryptedAuth,
  upsertAccount,
} from './account/store.ts';

dotenv.config();

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chrome';
}

async function main() {
  const browserType = parseBrowser();
  const account = resolveAccountId(argValue('account') || process.env.MANUS_ACCOUNT);
  const minutes = Number(argValue('minutes') || '15');

  console.log('');
  console.log('  ManusProxy · LOGIN');
  console.log('  ──────────────────');
  console.log(`  account  ${account}`);
  console.log(`  browser  ${browserType}`);
  console.log(`  profile  ${getProfilePath(account)}`);
  console.log('');
  console.log('  1. Na janela que abrir, faça login (email / Google).');
  console.log('  2. Passe o Turnstile se pedir.');
  console.log('  3. Espere cair no app da Manus.');
  console.log('  4. Eu detecto a sessão e salvo o auth (vault criptografado).');
  console.log('');

  upsertAccount(account, { label: account });
  await initPlaywright(false, browserType, account);
  const { activePage } = await import('./services/playwright.ts');
  if (activePage) {
    await activePage.goto('https://manus.im/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  }

  const ok = await waitForLogin(account, Math.max(60, minutes * 60) * 1000);
  if (!ok) {
    console.error('[login] Timeout — não detectei sessão a tempo.');
    await closePlaywright();
    process.exit(1);
  }

  try {
    // Give the app a moment to fire authenticated RPCs after landing
    await new Promise((r) => setTimeout(r, 3000));

    const auth = await getManusAuth(account, true);
    await saveCaptureDump(
      'auth',
      {
        hasAuthorization: Boolean(auth.authorization),
        authorizationPrefix: auth.authorization.slice(0, 24),
        cookieNames: auth.cookie
          .split(';')
          .map((c) => c.trim().split('=')[0])
          .filter(Boolean),
        extras: Object.keys(auth.extras),
        userAgent: auth.userAgent,
      },
      account
    );

    const user = await getUserInfo(account);
    const credits = await getAvailableCredits(account);
    console.log('');
    console.log(`[login] UserInfo  → ${user.status} ${user.ok ? 'OK' : 'FAIL'}`);
    if (user.ok) console.log(`[login] body: ${JSON.stringify(user.body).slice(0, 400)}`);
    else console.log(`[login] body: ${user.raw.slice(0, 400)}`);
    console.log(`[login] Credits   → ${credits.status} ${credits.ok ? 'OK' : 'FAIL'}`);
    if (credits.ok) console.log(`[login] body: ${JSON.stringify(credits.body).slice(0, 400)}`);
    console.log('');

    if (!user.ok || !auth.authorization) {
      console.log('  ⚠ Sessão incompleta (falta Authorization ou UserInfo 401).');
      console.log('  Deixe a janela no app logado e rode de novo: npm run login:chrome');
      console.log('  Ou: npm run session');
      console.log('');
      await closePlaywright();
      process.exit(2);
    }

    const u = user.body as { email?: string; displayname?: string; userId?: string };
    markAccountReady(account, {
      email: u.email,
      displayName: u.displayname,
      userId: u.userId,
    });
    storeEncryptedAuth(account, {
      authorization: auth.authorization,
      extras: auth.extras,
      capturedAt: auth.capturedAt,
    });

    console.log('  Login concluído. Profile sticky + vault criptografado.');
    console.log(`  account=${account}`);
    console.log('  Depois:  npm start');
    console.log('  Multi:   npm run login -- --account=outra');
    console.log('');
  } catch (err) {
    console.error('[login] Auth capture failed:', err);
    console.log('  Se você logou, o profile ainda está salvo — tente npm run session');
  }

  await closePlaywright();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
