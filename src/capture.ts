/**
 * Capture authenticated Manus web API traffic.
 * You send 1 message in the app UI; we dump requests/responses to capture/.
 */
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  closePlaywright,
  getProfilePath,
  initPlaywright,
  resolveAccountId,
  type BrowserType,
} from './services/playwright.ts';

dotenv.config();

type Cap = {
  t: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  status?: number;
  resHeaders?: Record<string, string>;
  resBody?: string;
};

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chrome';
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return undefined;
}

async function main() {
  const browserType = parseBrowser();
  const account = resolveAccountId(argValue('account') || process.env.MANUS_ACCOUNT);
  const minutes = Number(argValue('minutes') || '8');
  const caps: Cap[] = [];

  console.log('');
  console.log('  ManusProxy · CAPTURE');
  console.log('  ────────────────────');
  console.log(`  account  ${account}`);
  console.log(`  profile  ${getProfilePath(account)}`);
  console.log(`  window   ${minutes} min`);
  console.log('');
  console.log('  Abra um chat e envie UMA mensagem real.');
  console.log('  Vou gravar tudo em api.manus.im → capture/');
  console.log('');

  await initPlaywright(false, browserType, account);
  const { activePage } = await import('./services/playwright.ts');
  if (!activePage) throw new Error('no page');

  activePage.on('request', (req) => {
    const url = req.url();
    if (!url.includes('api.manus.im') && !url.includes('manus.im') && !url.includes('event')) {
      // only api
    }
    if (!url.includes('api.manus.im')) return;
    const headers = req.headers();
    // strip secrets partially for disk safety? keep full for reverse eng of own account
    caps.push({
      t: new Date().toISOString(),
      method: req.method(),
      url,
      reqHeaders: {
        authorization: headers.authorization ? `${headers.authorization.slice(0, 20)}…` : '',
        cookie: headers.cookie ? '(present)' : '',
        'content-type': headers['content-type'] || '',
        'connect-protocol-version': headers['connect-protocol-version'] || '',
        ...Object.fromEntries(
          Object.entries(headers).filter(([k]) => k.startsWith('x-'))
        ),
      },
      reqBody: req.postData() || null,
    });
    console.log(`[cap] → ${req.method()} ${url.replace('https://api.manus.im', '')}`);
  });

  activePage.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('api.manus.im')) return;
    const req = res.request();
    const entry = [...caps]
      .reverse()
      .find((c) => c.url === url && c.method === req.method() && c.status === undefined);
    if (!entry) return;
    entry.status = res.status();
    try {
      const text = await res.text();
      entry.resBody = text.slice(0, 200_000);
    } catch {
      entry.resBody = '(unreadable)';
    }
    console.log(`[cap] ← ${entry.status} ${url.replace('https://api.manus.im', '')}`);
  });

  await activePage.goto('https://manus.im/app', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  }).catch(() =>
    activePage!.goto('https://manus.im/', { waitUntil: 'domcontentloaded' })
  );

  await new Promise((r) => setTimeout(r, minutes * 60 * 1000));

  const dir = path.resolve('capture');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}_${account}_network.json`);
  fs.writeFileSync(file, JSON.stringify(caps, null, 2), 'utf8');
  console.log('');
  console.log(`[capture] ${caps.length} requests → ${file}`);
  console.log('');

  await closePlaywright();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
