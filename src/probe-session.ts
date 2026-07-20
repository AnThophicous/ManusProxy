import * as dotenv from 'dotenv';
import {
  closePlaywright,
  getManusAuth,
  initPlaywright,
  saveCaptureDump,
} from './services/playwright.ts';
import { manusRpc } from './manus/client.ts';

dotenv.config();

const SID = process.argv.find((a) => a.startsWith('--sid='))?.split('=')[1] ||
  'pTSSpqgdOKbQGbgEz4EXKx';

async function main() {
  await initPlaywright(false, 'chrome');
  await getManusAuth(undefined, true);

  const methods = [
    ['session.v1.SessionService/GetSession', { sessionUid: SID }],
    ['session.v1.SessionService/ListSessions', { limit: 10, noProject: true }],
    ['session.v1.SessionService/GetSessionEvents', { sessionUid: SID }],
    ['session.v1.SessionService/ListEvents', { sessionUid: SID }],
    ['session.v1.SessionService/GetEvents', { sessionUid: SID }],
    ['session.v1.SessionService/ListMessages', { sessionUid: SID }],
    ['session.v1.SessionService/GetMessages', { sessionUid: SID }],
    ['session.v1.SessionService/GetSessionDetail', { sessionUid: SID }],
    ['session.v1.SessionService/GetSessionHistory', { sessionUid: SID }],
    ['orchestrator.v1.OrchestratorService/GetSession', { sessionUid: SID }],
    ['orchestrator.v1.OrchestratorService/GetSession', {}],
    ['orchestrator.v1.OrchestratorService/ListEvents', { sessionUid: SID }],
    ['orchestrator.v1.OrchestratorService/GetEvents', { sessionUid: SID }],
  ] as const;

  const out: unknown[] = [];
  for (const [method, body] of methods) {
    const r = await manusRpc(method, body);
    console.log(r.status, method, r.raw.slice(0, 250).replace(/\n/g, ' '));
    out.push({ method, body, status: r.status, raw: r.raw.slice(0, 20_000) });
  }

  await saveCaptureDump('session-probe', out);
  await closePlaywright();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
