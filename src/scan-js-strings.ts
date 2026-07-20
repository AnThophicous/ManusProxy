import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
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
  await page.waitForTimeout(5000);

  const urls = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('.js'))
  );
  console.log('js count', urls.length);

  const found: string[] = [];
  const keywords = [
    'CreateSession',
    'createSession',
    'SendMessage',
    'sendMessage',
    'SessionService',
    'OrchestratorService',
    'StartSession',
    'NewSession',
    'SubmitUser',
    'UserMessage',
    'chatMode',
    'taskMode',
    'CreateTask',
    'RunSession',
    'eventSource',
    'text/event-stream',
  ];

  for (const url of urls.slice(0, 120)) {
    try {
      const res = await page.request.get(url);
      const t = await res.text();
      for (const k of keywords) {
        let idx = 0;
        let n = 0;
        while ((idx = t.indexOf(k, idx)) !== -1 && n < 2) {
          found.push(`${k} @ ${url.split('/').pop()} :: ${t.slice(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, ' ')}`);
          idx += k.length;
          n++;
        }
      }
      const quoted = t.match(/["']([A-Za-z0-9_]+Service\/[A-Za-z0-9_]+)["']/g);
      if (quoted) {
        for (const q of quoted.slice(0, 40)) found.push(`quoted ${q}`);
      }
      const svc = t.match(/SessionService\/[A-Za-z0-9_]+/g);
      if (svc) for (const s of svc) found.push(s);
      const orch = t.match(/OrchestratorService\/[A-Za-z0-9_]+/g);
      if (orch) for (const s of orch) found.push(s);
    } catch {
      /* ignore */
    }
  }

  const uniq = [...new Set(found)].sort();
  fs.mkdirSync('capture', { recursive: true });
  const out = path.join('capture', 'js-strings.json');
  fs.writeFileSync(out, JSON.stringify(uniq, null, 2));
  console.log(uniq.join('\n'));
  console.log('wrote', out, 'count', uniq.length);
  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
