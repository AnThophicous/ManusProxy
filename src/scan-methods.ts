import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  closePlaywright,
  getManusAuth,
  initPlaywright,
  activePage,
  type BrowserType,
} from './services/playwright.ts';

dotenv.config();

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  return 'chrome';
}

async function scanText(text: string, found: Set<string>) {
  const patterns = [
    /[A-Za-z0-9_]+Service\/[A-Za-z0-9_]+/g,
    /[a-z]+\.v\d+\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+/g,
    /api\.manus\.im\/[A-Za-z0-9_./]+/g,
  ];
  for (const re of patterns) {
    for (const m of text.match(re) || []) {
      if (/Session|Chat|Task|Agent|Message|Event|User|File|Workspace|Project|Prompt|Stream/i.test(m)) {
        found.add(m);
      }
    }
  }
}

async function main() {
  await initPlaywright(false, parseBrowser());
  await getManusAuth(undefined, true);
  if (!activePage) throw new Error('no page');
  const page = activePage;

  const networkHits = new Set<string>();
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('api.manus.im')) {
      networkHits.add(`${req.method()} ${u}`);
    }
  });

  await page
    .goto('https://manus.im/app', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch(() => page.goto('https://manus.im/', { waitUntil: 'domcontentloaded' }));
  await page.waitForTimeout(4000);

  // Try common SPA entry paths
  for (const pathTry of ['/app', '/home', '/new', '/']) {
    await page.goto(`https://manus.im${pathTry}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const scripts = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map((s) => (s as HTMLScriptElement).src)
  );
  console.log('scripts', scripts.length);

  const found = new Set<string>();
  // Also performance resource entries
  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name)
  );
  const urls = [...new Set([...scripts, ...resources])].filter(
    (u) =>
      typeof u === 'string' &&
      (u.includes('_next') || u.includes('static') || u.includes('chunk') || u.endsWith('.js'))
  );

  console.log('js urls', urls.length);
  let scanned = 0;
  for (const url of urls.slice(0, 80)) {
    try {
      const res = await page.request.get(url);
      if (!res.ok()) continue;
      const text = await res.text();
      await scanText(text, found);
      scanned++;
    } catch {
      /* ignore */
    }
  }

  // Inline scripts
  const inlines = await page.evaluate(() =>
    [...document.scripts]
      .filter((s) => !s.src)
      .map((s) => s.textContent || '')
      .join('\n')
  );
  await scanText(inlines, found);

  const out = {
    url: page.url(),
    scanned,
    networkHits: [...networkHits].sort(),
    found: [...found].sort(),
  };
  fs.mkdirSync('capture', { recursive: true });
  const file = path.join('capture', `methods-scan-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('networkHits', out.networkHits);
  console.log('found', out.found);
  console.log('wrote', file);

  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
