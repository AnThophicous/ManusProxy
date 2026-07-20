/**
 * Open app, try to send one test message via UI, dump api.manus.im traffic.
 */
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  activePage,
  closePlaywright,
  getManusAuth,
  initPlaywright,
  type BrowserType,
} from './services/playwright.ts';
import { manusRpc } from './manus/client.ts';

dotenv.config();

type Cap = {
  t: string;
  method: string;
  url: string;
  path: string;
  reqBody: string | null;
  status?: number;
  resBody?: string;
};

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  return 'chrome';
}

async function main() {
  const caps: Cap[] = [];
  await initPlaywright(false, parseBrowser());
  await getManusAuth(undefined, true);
  if (!activePage) throw new Error('no page');
  const page = activePage;

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('api.manus.im')) return;
    if (url.includes('user_behavior') || url.includes('batch_create_event')) return;
    caps.push({
      t: new Date().toISOString(),
      method: req.method(),
      url,
      path: url.replace('https://api.manus.im/', ''),
      reqBody: req.postData() || null,
    });
    console.log('→', req.method(), url.replace('https://api.manus.im/', ''));
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('api.manus.im')) return;
    if (url.includes('user_behavior') || url.includes('batch_create_event')) return;
    const entry = [...caps]
      .reverse()
      .find((c) => c.url === url && c.status === undefined);
    if (!entry) return;
    entry.status = res.status();
    try {
      entry.resBody = (await res.text()).slice(0, 100_000);
    } catch {
      entry.resBody = '(unreadable)';
    }
    console.log('←', entry.status, entry.path);
  });

  // Probe orchestrator + session variants
  const probes = [
    'orchestrator.v1.OrchestratorService/GetSession',
    'orchestrator.v1.OrchestratorService/CreateSession',
    'orchestrator.v1.OrchestratorService/Create',
    'orchestrator.v1.OrchestratorService/StartSession',
    'orchestrator.v1.OrchestratorService/Run',
    'orchestrator.v1.OrchestratorService/SendMessage',
    'orchestrator.v1.OrchestratorService/Chat',
    'orchestrator.v1.OrchestratorService/NewSession',
    'orchestrator.v1.OrchestratorService/Submit',
    'session.v1.SessionService/CreateSessionV2',
    'session.v1.SessionService/CreateSessionFromPrompt',
    'session.v1.SessionService/CreateNewSession',
    'session.v1.SessionService/NewChat',
    'session.v1.SessionService/Chat',
    'session.v1.SessionService/Run',
    'session.v1.SessionService/Submit',
    'session.v1.SessionService/SubmitPrompt',
    'session.v1.SessionService/Start',
    'session.v1.SessionService/InitSession',
  ];

  console.log('--- RPC probes ---');
  for (const method of probes) {
    for (const body of [
      {},
      { prompt: 'Say hi in one word' },
      { message: 'Say hi in one word' },
      { content: 'Say hi in one word' },
    ]) {
      const r = await manusRpc(method, body);
      if (r.status === 404 && r.raw.includes('page not found')) {
        console.log(`404 ${method}`);
        break;
      }
      console.log(
        `${r.status} ${method} ${JSON.stringify(body).slice(0, 40)} → ${r.raw.slice(0, 160).replace(/\n/g, ' ')}`
      );
      if (r.ok) break;
    }
  }

  console.log('--- UI send attempt ---');
  await page.goto('https://manus.im/app', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Find composer
  const selectors = [
    'textarea:visible',
    '[contenteditable="true"]:visible',
    'div[role="textbox"]:visible',
    '[data-placeholder]:visible',
    'p[data-placeholder]',
    '.ProseMirror',
  ];

  let filled = false;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    try {
      await loc.click({ timeout: 3000 });
      await loc.fill('Responda apenas: pong');
      filled = true;
      console.log('filled via', sel);
      break;
    } catch {
      try {
        await loc.click({ timeout: 2000 });
        await page.keyboard.type('Responda apenas: pong', { delay: 20 });
        filled = true;
        console.log('typed via', sel);
        break;
      } catch {
        /* next */
      }
    }
  }

  if (!filled) {
    // dump interactive elements
    const snap = await page.evaluate(() => {
      const els = [...document.querySelectorAll('textarea, [contenteditable], [role="textbox"], button')];
      return els.slice(0, 40).map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
        aria: el.getAttribute('aria-label'),
        text: (el.textContent || '').slice(0, 80),
        cls: (el as HTMLElement).className?.toString?.().slice(0, 80),
      }));
    });
    console.log('no composer; elements:', JSON.stringify(snap, null, 2));
  } else {
    // try send
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    // also try send button
    const sendBtn = page
      .locator(
        'button:has-text("Enviar"), button:has-text("Send"), button[aria-label*="Send" i], button[type="submit"]'
      )
      .first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click().catch(() => {});
    }
    console.log('waiting for network after send…');
    await page.waitForTimeout(12_000);
  }

  const dir = path.resolve('capture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ui-send-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(caps, null, 2));
  console.log('wrote', file, 'caps', caps.length);

  // list unique paths
  const paths = [...new Set(caps.map((c) => c.path))].sort();
  console.log('paths', paths);

  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
