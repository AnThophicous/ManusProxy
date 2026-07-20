/**
 * Append-only log TUI (Windows-safe).
 * - Never moves cursor up / never clears above.
 * - Prints a numbered list of useful logs (warm + live).
 * - Keys 1-9 expand detail BELOW (no redraw, no spam).
 */
import { getLogs, onLog, type LogEntry } from './log-bus.ts';
import { dim, soft, tag, white, bold, separator, leftPad } from './ansi.ts';
import {
  showCursor,
  isSmallScreen,
  isTermux,
  mouseTuiEnabled,
  hyperlink,
} from './env.ts';
import { FARLABS_DISCORD } from './ascii.ts';

let active = false;
let offLog: (() => void) | null = null;
let stdinHandler: ((buf: string | Buffer) => void) | null = null;
let printedIds = new Set<string>();
/** Keys 1-9 → log id (last 9 expandable entries) */
let keySlots: string[] = [];
const expandedOnce = new Set<string>();
let headerPrinted = false;

/** Skip noisy intermediate "rodando…" lines */
function isUsefulLog(e: LogEntry): boolean {
  if (e.summary === 'rodando…' || e.summary === 'rodando...') return false;
  if (e.level === 'info' && !e.detail && e.summary.endsWith('…')) return false;
  return true;
}

function toneOf(e: LogEntry): 'ok' | 'warn' | 'err' | 'info' | 'sys' {
  if (e.level === 'ok') return 'ok';
  if (e.level === 'warn') return 'warn';
  if (e.level === 'err') return 'err';
  if (e.level === 'sys') return 'sys';
  return 'info';
}

function formatHead(e: LogEntry, index: number): string {
  const compact = isSmallScreen() || isTermux();
  const marker = e.detail ? '>' : '.';
  const n = String(index).padStart(2, ' ');
  if (compact) {
    return leftPad(`${n} ${tag(e.tag, toneOf(e))} ${soft(e.summary)}`);
  }
  return leftPad(
    `${n} ${dim(marker)} ${tag(e.tag, toneOf(e))} ${white(e.title)} ${dim('-')} ${soft(e.summary)}`
  );
}

function printHeaderOnce(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  const cols = Math.min(process.stdout.columns || 64, 64);
  console.log(separator(cols));
  console.log(
    leftPad(
      dim('logs ') +
        soft('(1-9 expand detail below · q solta teclado)')
    )
  );
}

function registerAndPrint(e: LogEntry): void {
  if (!isUsefulLog(e)) return;
  if (printedIds.has(e.id)) return;
  printedIds.add(e.id);

  keySlots.push(e.id);
  if (keySlots.length > 9) keySlots = keySlots.slice(-9);

  printHeaderOnce();
  // Number = position among last 9 (what key 1-9 maps to)
  const idx = keySlots.indexOf(e.id) + 1;
  console.log(formatHead(e, idx));
}

function printExpandByKey(keyDigit: number): void {
  // key 1 = first of current keySlots window
  const id = keySlots[keyDigit - 1];
  if (!id) {
    console.log(leftPad(dim(`(no log #${keyDigit})`)));
    return;
  }
  const e = getLogs().find((x) => x.id === id);
  if (!e) return;

  if (expandedOnce.has(id)) {
    // silent — no spam
    return;
  }
  expandedOnce.add(id);

  console.log(leftPad(dim(`── #${keyDigit} ${e.tag}/${e.title} ──`)));
  if (!e.detail) {
    console.log(leftPad(soft('(no detail)')));
    return;
  }
  const compact = isSmallScreen() || isTermux();
  const max = compact ? 10 : 30;
  const lines = e.detail.split('\n').slice(0, max);
  for (const ln of lines) {
    const plain = ln.length > 120 ? ln.slice(0, 120) + '…' : ln;
    console.log(leftPad(dim('| ') + soft(plain)));
  }
  if (e.detail.split('\n').length > max) {
    console.log(leftPad(dim('| …')));
  }
}

function onStdinData(buf: string | Buffer): void {
  if (!active) return;
  try {
    const s = String(buf);
    if (s.includes('\x03')) {
      stopLogTui();
      process.exit(0);
    }
    if (s.includes('\x1b')) return; // ignore mouse/CSI

    for (const ch of s) {
      if (ch === 'q' || ch === 'Q') {
        console.log(leftPad(dim('tui keys off (server still running)')));
        detachStdin();
        return;
      }
      if (ch >= '1' && ch <= '9') {
        printExpandByKey(Number(ch));
      }
    }
  } catch {
    /* never crash */
  }
}

function detachStdin(): void {
  if (stdinHandler && process.stdin.isTTY) {
    process.stdin.off('data', stdinHandler);
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    stdinHandler = null;
  }
  showCursor();
}

function cleanupAlways(): void {
  detachStdin();
}

export function startLogTui(_opts?: { footer?: string }): void {
  if (active) return;
  active = true;
  printedIds = new Set();
  keySlots = [];
  expandedOnce.clear();
  headerPrinted = false;

  process.once('exit', cleanupAlways);
  process.once('SIGINT', () => {
    stopLogTui();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    stopLogTui();
    process.exit(0);
  });

  // Replay useful warm logs so the list is not empty
  printHeaderOnce();
  const useful = getLogs().filter(isUsefulLog).slice(-14);
  for (const e of useful) {
    registerAndPrint(e);
  }
  if (useful.length === 0) {
    console.log(leftPad(dim('(waiting for logs…)')));
  }

  offLog = onLog((e) => {
    registerAndPrint(e);
  });

  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      stdinHandler = onStdinData;
      process.stdin.on('data', stdinHandler);
    } catch {
      /* non-interactive */
    }
  }
}

export function stopLogTui(): void {
  if (!active) return;
  active = false;
  offLog?.();
  offLog = null;
  cleanupAlways();
}

export function printStatusBlock(opts: {
  localUrl: string;
  networkUrl?: string | null;
  browser: string;
  headless: boolean;
}): void {
  const cols = Math.min(process.stdout.columns || 64, 64);
  const line = separator(cols);

  console.log(line);
  console.log(leftPad(bold(white('______ Made by Farlabs ______'))));
  console.log(
    leftPad(soft('Discord  ') + hyperlink(FARLABS_DISCORD, FARLABS_DISCORD))
  );
  console.log(line);
  console.log(leftPad(tag('LIVE', 'ok') + '  ' + white(opts.localUrl)));
  if (opts.networkUrl) {
    console.log(leftPad(tag('NET', 'info') + '   ' + soft(opts.networkUrl)));
  }
  console.log(
    leftPad(
      tag('RUN', 'sys') +
        '   ' +
        soft(`${opts.browser} · headless=${opts.headless}`)
    )
  );
  console.log(
    leftPad(
      tag('TUI', 'info') +
        '   ' +
        soft('1-9 expand · q solta teclado · append-only')
    )
  );
  console.log(line);
  console.log('');
}

export { white, soft, bold } from './ansi.ts';
