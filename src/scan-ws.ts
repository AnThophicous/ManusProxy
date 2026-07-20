import * as dotenv from 'dotenv';
import fs from 'fs';
import {
  activePage,
  closePlaywright,
  getManusAuth,
  initPlaywright,
} from './services/playwright.ts';

dotenv.config();

async function main() {
  await initPlaywright(false, 'chrome');
  await getManusAuth(undefined, true);
  if (!activePage) throw new Error('no page');
  const page = activePage;
  await page.goto('https://manus.im/app', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4000);

  const urls = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('.js'))
  );

  const keywords = [
    'chatWebsocket',
    'wss://',
    'websocket',
    'socket.io',
    'joinNewSession',
    'createSessionEnvelope',
    'emit("message"',
    "emit('message'",
    'SESSION_CREATION',
    'AgentSession',
    'session.v1.Agent',
    'beforeSendSession',
    'ChatWebsocket',
    'chat.manus',
    'event.manus',
    'realtime',
  ];

  const found: string[] = [];
  for (const url of urls) {
    try {
      const res = await page.request.get(url);
      const t = await res.text();
      for (const k of keywords) {
        let idx = 0;
        let n = 0;
        while ((idx = t.indexOf(k, idx)) !== -1 && n < 3) {
          found.push(
            `${k} @ ${url.split('/').pop()} :: ${t
              .slice(Math.max(0, idx - 100), idx + 180)
              .replace(/\s+/g, ' ')}`
          );
          idx += k.length;
          n++;
        }
      }
      // protobuf type names
      const types = t.match(/session\.v1\.[A-Za-z0-9_]+/g);
      if (types) for (const x of types.slice(0, 40)) found.push(`type ${x}`);
      const orch = t.match(/orchestrator\.v1\.[A-Za-z0-9_]+/g);
      if (orch) for (const x of orch.slice(0, 40)) found.push(`type ${x}`);
    } catch {
      /* ignore */
    }
  }

  // Also capture live websockets by opening session and listening
  const wsUrls: string[] = [];
  page.on('websocket', (ws) => {
    wsUrls.push(ws.url());
    console.log('WS open', ws.url());
    ws.on('framesent', (f) => console.log('WS →', String(f.payload).slice(0, 300)));
    ws.on('framereceived', (f) => console.log('WS ←', String(f.payload).slice(0, 300)));
  });

  // open the known session
  await page.goto('https://manus.im/app/pTSSpqgdOKbQGbgEz4EXKx', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  }).catch(async () => {
    // try alternate routes
    for (const p of [
      '/app/session/pTSSpqgdOKbQGbgEz4EXKx',
      '/session/pTSSpqgdOKbQGbgEz4EXKx',
      '/chat/pTSSpqgdOKbQGbgEz4EXKx',
    ]) {
      await page.goto(`https://manus.im${p}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  });
  await page.waitForTimeout(8000);

  // try homepage new chat send with better selectors
  await page.goto('https://manus.im/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const composer = page.locator('[contenteditable="true"]:visible').first();
  if ((await composer.count()) > 0) {
    await composer.click();
    await page.keyboard.type('diga só: ok', { delay: 15 });
    // try common send combos
    for (const combo of [
      async () => page.keyboard.press('Control+Enter'),
      async () => page.keyboard.press('Meta+Enter'),
      async () => page.keyboard.press('Enter'),
      async () => {
        const btn = page.locator('button').filter({ hasText: /enviar|send|run|go/i }).first();
        if ((await btn.count()) > 0) await btn.click();
      },
      async () => {
        // last button near composer
        await page.locator('button:near([contenteditable="true"])').last().click({ timeout: 2000 });
      },
    ]) {
      try {
        await combo();
        await page.waitForTimeout(2500);
        if (wsUrls.length) break;
      } catch {
        /* next */
      }
    }
  }

  await page.waitForTimeout(5000);

  const uniq = [...new Set(found)].sort();
  fs.writeFileSync(
    'capture/ws-scan.json',
    JSON.stringify({ wsUrls, found: uniq }, null, 2)
  );
  console.log('wsUrls', wsUrls);
  console.log('found count', uniq.length);
  for (const line of uniq.slice(0, 80)) console.log(line);

  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
