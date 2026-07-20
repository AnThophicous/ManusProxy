/** Terminal capability detection */

export function isTermux(): boolean {
  return Boolean(
    process.env.TERMUX_VERSION ||
      process.env.PREFIX?.includes('com.termux') ||
      process.env.ANDROID_ROOT
  );
}

export function isSmallScreen(): boolean {
  if (isTermux()) return true;
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return cols < 70 || rows < 20;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function supportsHyperlinks(): boolean {
  if (process.env.FORCE_HYPERLINK === '1') return true;
  if (process.env.FORCE_HYPERLINK === '0') return false;
  // Windows Terminal
  if (process.env.WT_SESSION) return true;
  if (process.env.TERM_PROGRAM === 'iTerm.app') return true;
  if (process.env.VTE_VERSION && Number(process.env.VTE_VERSION) >= 5000) return true;
  if (isTermux()) return true;
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[2J\x1b[H');
}

export function hideCursor(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25l');
}

export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
}

/**
 * Clickable link when terminal supports OSC 8.
 * Never prints URL twice.
 */
export function hyperlink(url: string, label?: string): string {
  const text = label || url;
  if (!supportsHyperlinks()) {
    // one string only — never duplicate
    return label && label !== url ? `${label}` : url;
  }
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Whether mouse TUI should be enabled (off by default on win32 unless forced) */
export function mouseTuiEnabled(): boolean {
  if (process.env.MANUS_TUI_MOUSE === '0') return false;
  if (process.env.MANUS_TUI_MOUSE === '1') return true;
  if (isTermux() || isSmallScreen()) return false;
  // Windows raw mouse is flaky outside Windows Terminal
  if (isWindows() && !process.env.WT_SESSION) return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
