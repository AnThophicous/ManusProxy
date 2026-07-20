/**
 * Probe Manus web RPC methods after login.
 * Dumps candidates that return non-404 for session/chat create.
 */
import * as dotenv from 'dotenv';
import {
  closePlaywright,
  getManusAuth,
  initPlaywright,
  saveCaptureDump,
  type BrowserType,
} from './services/playwright.ts';
import { manusRpc } from './manus/client.ts';

dotenv.config();

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chrome';
}

const METHODS = [
  'session.v1.SessionService/CreateSession',
  'session.v1.SessionService/Create',
  'session.v1.SessionService/NewSession',
  'session.v1.SessionService/StartSession',
  'session.v1.SessionService/ListSessions',
  'session.v1.SessionService/GetSession',
  'session.v1.SessionService/SendMessage',
  'chat.v1.ChatService/CreateChat',
  'chat.v1.ChatService/SendMessage',
  'chat.v1.ChatService/Chat',
  'agent.v1.AgentService/CreateTask',
  'agent.v1.AgentService/Run',
  'task.v1.TaskService/CreateTask',
  'task.v1.TaskService/Create',
  'user.v1.UserService/UserInfo',
  'user.v1.UserService/GetAvailableCredits',
];

const BODIES: unknown[] = [
  {},
  { prompt: 'ping' },
  { message: 'ping' },
  { content: 'ping' },
  { text: 'ping' },
  { query: 'ping' },
  { mode: 'chat', prompt: 'ping' },
  { taskMode: 'chat', prompt: 'ping' },
  { messages: [{ role: 'user', content: 'ping' }] },
];

async function main() {
  const browserType = parseBrowser();
  await initPlaywright(false, browserType);
  const auth = await getManusAuth(undefined, true);
  console.log('auth ok', Boolean(auth.authorization));

  const hits: unknown[] = [];

  for (const method of METHODS) {
    // light probe with empty / simple bodies first
    for (const body of BODIES.slice(0, 4)) {
      const r = await manusRpc(method, body);
      const interesting =
        r.status !== 404 &&
        r.status !== 501 &&
        !String(r.raw).includes('Not Found') &&
        !String(r.raw).toLowerCase().includes('unimplemented');

      const line = {
        method,
        bodyKeys: body && typeof body === 'object' ? Object.keys(body as object) : [],
        status: r.status,
        ok: r.ok,
        snippet: r.raw.slice(0, 280),
      };
      console.log(
        `${r.ok ? '✓' : '·'} ${r.status} ${method} body=${JSON.stringify(body).slice(0, 40)} → ${r.raw.slice(0, 100).replace(/\n/g, ' ')}`
      );
      if (interesting || r.ok) hits.push(line);
      // stop body variants if method clearly wrong
      if (r.status === 404 || r.status === 501) break;
      if (r.ok) break;
    }
  }

  await saveCaptureDump('probe-hits', hits);
  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
