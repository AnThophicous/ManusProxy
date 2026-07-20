import {
  MANUS_LOGO_COMPACT,
  MANUS_LOGO_FULL,
  MANUS_PROXY_BANNER_COMPACT,
  MANUS_PROXY_BANNER_FULL,
  FARLABS_DISCORD,
} from './ascii.ts';
import {
  dim,
  soft,
  tag,
  white,
  bold,
  separator,
  center,
  leftPad,
  gradientByIndex,
  bannerLine,
  accent,
  SPINNER,
} from './ansi.ts';
import {
  clearScreen,
  hideCursor,
  showCursor,
  isSmallScreen,
  isTermux,
  sleep,
} from './env.ts';
import { log } from './log-bus.ts';
import { printStatusBlock, startLogTui } from './tui.ts';

export type BootstrapContext = {
  browser: string;
  headless: boolean;
  port: number;
  localUrl: string;
  networkUrl: string | null;
  checks: Array<{
    name: string;
    run: () => Promise<{ ok: boolean; summary: string; detail?: string | object }>;
  }>;
};

async function typeAsciiLogo(logo: string, lineDelay: number): Promise<void> {
  const lines = logo.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      process.stdout.write('\n');
    } else {
      process.stdout.write(leftPad(gradientByIndex(line, i, lines.length)) + '\n');
    }
    await sleep(lineDelay);
  }
}

async function revealBanner(banner: string, compact: boolean): Promise<void> {
  const lines = banner
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const painted = compact
      ? accent('cyan', line)
      : bannerLine(line, i, lines.length);
    process.stdout.write(center(painted) + '\n');
    await sleep(compact ? 40 : 70);
  }
}

/** Fake-but-pretty progress spinner while a check runs */
async function withSpinner(
  label: string,
  work: () => Promise<{ ok: boolean; summary: string; detail?: string | object }>,
  compact: boolean
): Promise<{ ok: boolean; summary: string; detail?: string | object }> {
  let i = 0;
  let running = true;
  const spin = async () => {
    while (running && process.stdout.isTTY) {
      const frame = SPINNER[i % SPINNER.length];
      process.stdout.write(
        `\r${leftPad(accent('cyan', frame) + '  ' + white(label.padEnd(14)) + dim('  aquecendo…'))}`
      );
      i++;
      await sleep(compact ? 50 : 80);
    }
  };
  const spinnerTask = spin();
  try {
    const res = await work();
    running = false;
    await spinnerTask.catch(() => {});
    process.stdout.write('\r\x1b[2K');
    return res;
  } catch (err) {
    running = false;
    await spinnerTask.catch(() => {});
    process.stdout.write('\r\x1b[2K');
    throw err;
  }
}

export async function runBootstrap(ctx: BootstrapContext): Promise<void> {
  const compact = isSmallScreen() || isTermux();
  // Slower, deliberate warmup feel
  const lineDelay = compact ? 18 : 42;
  const cols = Math.min(process.stdout.columns || 64, compact ? 48 : 64);

  hideCursor();
  try {
    if (process.stdout.isTTY) clearScreen();

    // ── Phase 1: logo ──────────────────────────────────────
    log.sys('BOOT', 'bootstrap', compact ? 'compact (termux/mobile)' : 'desktop warmup');
    if (!compact) {
      process.stdout.write(
        dim('\n') + leftPad(accent('violet', '▸') + ' ' + soft('compondo marca…')) + '\n\n'
      );
      await typeAsciiLogo(MANUS_LOGO_FULL, lineDelay);
      await sleep(320);
    } else {
      process.stdout.write('\n' + center(soft(MANUS_LOGO_COMPACT)) + '\n\n');
      await sleep(280);
    }

    // ── Phase 2: real warmup checks ────────────────────────
    process.stdout.write('\n');
    process.stdout.write(
      leftPad(
        tag('WARM', 'warm') + ' ' + soft('aquecendo runtime · checagens reais…')
      ) + '\n\n'
    );
    await sleep(compact ? 200 : 450);

    for (const check of ctx.checks) {
      log.info('WARM', check.name, 'rodando…');
      try {
        const res = await withSpinner(check.name, check.run, compact);
        if (res.ok) {
          log.ok('WARM', check.name, res.summary, res.detail);
          process.stdout.write(
            leftPad(
              tag('OK', 'ok') +
                '  ' +
                white(check.name.padEnd(14)) +
                dim('  ') +
                soft(res.summary)
            ) + '\n'
          );
        } else {
          log.warn('WARM', check.name, res.summary, res.detail);
          process.stdout.write(
            leftPad(
              tag('WARN', 'warn') +
                '  ' +
                white(check.name.padEnd(14)) +
                dim('  ') +
                soft(res.summary)
            ) + '\n'
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.err('WARM', check.name, msg);
        process.stdout.write(
          leftPad(
            tag('ERR', 'err') +
              '  ' +
              white(check.name.padEnd(14)) +
              dim('  ') +
              soft(msg.slice(0, 90))
          ) + '\n'
        );
      }
      await sleep(compact ? 120 : 280);
    }

    await sleep(compact ? 250 : 600);

    // ── Phase 3: clear → banner + Farlabs (branding only) ──
    if (process.stdout.isTTY) clearScreen();

    process.stdout.write('\n');
    if (compact) {
      process.stdout.write(center(bold(accent('cyan', MANUS_PROXY_BANNER_COMPACT))) + '\n\n');
    } else {
      await revealBanner(MANUS_PROXY_BANNER_FULL, false);
      process.stdout.write('\n');
    }

    process.stdout.write(
      center(
        [
          tag('PROXY', 'ok'),
          tag('SSE', 'info'),
          tag('TOOLS', 'sys'),
          tag('ROTATE', 'warn'),
          compact ? null : tag('TUI', 'net'),
        ]
          .filter(Boolean)
          .join('  ')
      ) + '\n'
    );
    process.stdout.write(center(separator(cols)) + '\n\n');

    log.ok('READY', 'server', ctx.localUrl, {
      network: ctx.networkUrl,
      browser: ctx.browser,
      headless: ctx.headless,
    });

    printStatusBlock({
      localUrl: ctx.localUrl,
      networkUrl: ctx.networkUrl,
      browser: ctx.browser,
      headless: ctx.headless,
    });

    startLogTui();
  } finally {
    showCursor();
  }
}
