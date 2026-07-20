import * as dotenv from 'dotenv';
import {
  closePlaywright,
  getManusAuth,
  initPlaywright,
  resolveAccountId,
  type BrowserType,
} from './services/playwright.ts';
import { getAvailableCredits, getUserInfo } from './manus/client.ts';

dotenv.config();

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chrome';
}

async function main() {
  const browserType = parseBrowser();
  const account = resolveAccountId(process.env.MANUS_ACCOUNT);
  const headless = process.env.MANUS_HEADLESS === 'true';

  await initPlaywright(headless, browserType, account);
  const auth = await getManusAuth(account, true);
  console.log('auth:', {
    hasAuthorization: Boolean(auth.authorization),
    authorizationPrefix: auth.authorization.slice(0, 32),
    cookieLen: auth.cookie.length,
    extras: Object.keys(auth.extras),
  });

  const user = await getUserInfo(account);
  console.log('UserInfo:', user.status, user.ok ? user.body : user.raw.slice(0, 500));
  const credits = await getAvailableCredits(account);
  console.log('Credits:', credits.status, credits.ok ? credits.body : credits.raw.slice(0, 500));

  await closePlaywright();
  process.exit(user.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
