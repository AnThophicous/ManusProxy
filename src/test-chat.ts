/**
 * Quick end-to-end: auth + WS chat
 */
import * as dotenv from 'dotenv';
import { closePlaywright, initPlaywright } from './services/playwright.ts';
import { sendManusChat } from './manus/ws.ts';
import { getUserInfo } from './manus/client.ts';

dotenv.config();

async function main() {
  await initPlaywright(false, 'chrome');
  const user = await getUserInfo();
  console.log('user', user.status, user.ok);

  const result = await sendManusChat({
    prompt: 'Responda com uma única palavra: ping',
    model: 'manus-chat',
    timeoutMs: 120_000,
    handlers: {
      onDelta: (t) => {
        process.stdout.write(t);
      },
    },
  });

  console.log('\n---');
  console.log('session', result.sessionId);
  console.log('content', result.content);
  console.log('events', result.events.length);

  await closePlaywright();
  process.exit(result.content ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
