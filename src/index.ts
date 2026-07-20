import { serve } from '@hono/node-server';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';
import * as net from 'node:net';
import * as dotenv from 'dotenv';
import { app } from './app.ts';
import {
  initPlaywright,
  getManusAuth,
  type BrowserType,
  listAccounts,
} from './services/playwright.ts';
import { runBootstrap } from './cli/bootstrap.ts';
import { log } from './cli/log-bus.ts';
import { listStoredAccounts } from './account/store.ts';
import { BUILTIN_TOOLS } from './tools/builtin.ts';
import { fingerprintSecret } from './account/crypto.ts';
import { FARLABS_DISCORD } from './cli/ascii.ts';
import { getUserInfo, getAvailableCredits } from './manus/client.ts';

dotenv.config();

export { app } from './app.ts';

function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function parseBrowser(): BrowserType {
  const browserArg = process.argv.find((arg) => arg.startsWith('--browser='));
  if (browserArg) return browserArg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chrome';
}

function parseHeadless(): boolean {
  if (process.argv.includes('--headed')) return false;
  if (process.argv.includes('--headless')) return true;
  if (process.env.MANUS_HEADLESS === 'false') return false;
  return true;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '0.0.0.0');
  });
}

async function probeManusApi(): Promise<{ ok: boolean; ms: number; status?: number; err?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.manus.im/user.v1.UserPublicService/CheckRegion', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://manus.im',
        referer: 'https://manus.im/',
      },
      body: '{}',
      signal: AbortSignal.timeout(12_000),
    });
    return { ok: res.ok || res.status < 500, ms: Date.now() - t0, status: res.status };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browserType = parseBrowser();
  const headless = parseHeadless();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3010;
  const networkIP = getNetworkAddress();
  const localUrl = `http://localhost:${port}`;
  const networkUrl = networkIP ? `http://${networkIP}:${port}` : null;

  const checks: Array<{
    name: string;
    run: () => Promise<{ ok: boolean; summary: string; detail?: string | object }>;
  }> = [
    {
      name: 'node',
      run: async () => ({
        ok: true,
        summary: process.version,
        detail: { platform: process.platform, arch: process.arch, pid: process.pid },
      }),
    },
    {
      name: 'env',
      run: async () => ({
        ok: true,
        summary: `PORT=${port} · ${browserType} · headless=${headless}`,
        detail: {
          MANUS_ACCOUNT: process.env.MANUS_ACCOUNT || 'default',
          API_KEY: process.env.API_KEY ? '(set)' : '(open)',
          vault: fingerprintSecret(),
          THINK_MODE: process.env.MANUS_THINK_MODE || 'both',
        },
      }),
    },
    {
      name: 'port',
      run: async () => {
        const free = await portFree(port);
        return {
          ok: free,
          summary: free ? `:${port} livre` : `:${port} ocupada — mate o processo ou mude PORT`,
          detail: { port, free },
        };
      },
    },
    {
      name: 'vault',
      run: async () => {
        const accounts = listStoredAccounts();
        const ready = accounts.filter((a) => a.ready).length;
        return {
          ok: true,
          summary: `${accounts.length} conta(s) · ${ready} ready`,
          detail: accounts.map((a) => ({ id: a.id, ready: a.ready })),
        };
      },
    },
    {
      name: 'profiles',
      run: async () => {
        const profiles = listAccounts();
        return {
          ok: profiles.length > 0,
          summary: profiles.length
            ? profiles.join(', ')
            : 'nenhum profile — rode npm run login',
          detail: { profiles },
        };
      },
    },
    {
      name: 'tools',
      run: async () => ({
        ok: true,
        summary: `${BUILTIN_TOOLS.length} builtins · ${app.routes.length} routes`,
        detail: {
          tools: BUILTIN_TOOLS.map((t) => t.function.name),
          routes: app.routes.map((r) => `${r.method} ${r.path}`),
        },
      }),
    },
    {
      name: 'api.manus',
      run: async () => {
        const probe = await probeManusApi();
        return {
          ok: probe.ok,
          summary: probe.ok
            ? `api.manus.im ok · ${probe.ms}ms · HTTP ${probe.status}`
            : `api.manus.im falhou · ${probe.err || probe.status}`,
          detail: probe,
        };
      },
    },
    {
      name: 'browser',
      run: async () => {
        await initPlaywright(headless, browserType);
        return {
          ok: true,
          summary: `${browserType} headless=${headless} · profile sticky`,
          detail: { browserType, headless },
        };
      },
    },
    {
      name: 'session',
      run: async () => {
        try {
          const auth = await getManusAuth(undefined, true);
          const hasJwt = Boolean(auth.authorization);
          if (!hasJwt) {
            return {
              ok: false,
              summary: 'sem JWT — rode npm run login',
              detail: { hasAuthorization: false },
            };
          }
          const user = await getUserInfo();
          if (!user.ok) {
            return {
              ok: false,
              summary: `UserInfo ${user.status} — re-login`,
              detail: { status: user.status, raw: user.raw.slice(0, 200) },
            };
          }
          const u = user.body as { email?: string; displayname?: string };
          return {
            ok: true,
            summary: `auth ok · ${u.displayname || u.email || 'user'}`,
            detail: {
              email: u.email,
              displayname: u.displayname,
              authPrefix: auth.authorization.slice(0, 18) + '…',
            },
          };
        } catch (err) {
          return {
            ok: false,
            summary: err instanceof Error ? err.message.slice(0, 80) : String(err),
          };
        }
      },
    },
    {
      name: 'credits',
      run: async () => {
        try {
          const c = await getAvailableCredits();
          if (!c.ok) {
            return {
              ok: false,
              summary: `créditos indisponíveis (${c.status})`,
              detail: { status: c.status },
            };
          }
          const b = c.body as {
            totalCredits?: number;
            freeCredits?: number;
            refreshCredits?: number;
          };
          const total = Number(b.totalCredits ?? 0);
          return {
            ok: total > 0,
            summary: total > 0
              ? `créditos ${total} · free ${b.freeCredits ?? 0} · refresh ${b.refreshCredits ?? 0}`
              : 'créditos zerados — rotacione conta ou espere refresh',
            detail: b,
          };
        } catch (err) {
          return {
            ok: false,
            summary: err instanceof Error ? err.message.slice(0, 80) : String(err),
          };
        }
      },
    },
  ];

  runBootstrap({
    browser: browserType,
    headless,
    port,
    localUrl,
    networkUrl,
    checks,
  })
    .then(() => {
      try {
        serve({
          fetch: app.fetch,
          port,
        });
        log.ok('HTTP', 'listen', localUrl, {
          routes: app.routes.map((r) => `${r.method} ${r.path}`),
          network: networkUrl,
        });
      } catch (err) {
        log.err('HTTP', 'listen', err instanceof Error ? err.message : String(err));
        throw err;
      }
    })
    .catch((err: unknown) => {
      import('./cli/tui.ts')
        .then((m) => m.stopLogTui())
        .catch(() => {});
      console.error('Failed to bootstrap ManusProxy:', err);
      process.exit(1);
    });
}
