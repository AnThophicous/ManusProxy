import { supportsColor } from './env.ts';

/** Gray → white soft palette (zinc) + accents */
const GRAY = {
  50: [250, 250, 250],
  100: [244, 244, 245],
  200: [228, 228, 231],
  300: [212, 212, 216],
  400: [161, 161, 170],
  500: [113, 113, 122],
  600: [82, 82, 91],
  700: [63, 63, 70],
  800: [39, 39, 42],
  900: [24, 24, 27],
} as const;

const ACCENT = {
  cyan: [125, 211, 252],
  blue: [147, 197, 253],
  mint: [167, 243, 208],
  green: [134, 239, 172],
  amber: [253, 230, 138],
  rose: [253, 164, 175],
  violet: [196, 181, 253],
} as const;

function rgb(r: number, g: number, b: number, text: string): string {
  if (!supportsColor()) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function gray(level: keyof typeof GRAY, text: string): string {
  const [r, g, b] = GRAY[level];
  return rgb(r, g, b, text);
}

export function accent(
  name: keyof typeof ACCENT,
  text: string
): string {
  const [r, g, b] = ACCENT[name];
  return rgb(r, g, b, text);
}

export function dim(text: string): string {
  return gray(500, text);
}

export function soft(text: string): string {
  return gray(400, text);
}

export function mid(text: string): string {
  return gray(300, text);
}

export function bright(text: string): string {
  return gray(100, text);
}

export function white(text: string): string {
  return gray(50, text);
}

export function bold(text: string): string {
  if (!supportsColor()) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

/** Clean square tags with color by tone */
export function tag(
  label: string,
  tone: 'ok' | 'warn' | 'err' | 'info' | 'sys' | 'warm' | 'net' = 'info'
): string {
  const map: Record<string, readonly [number, number, number]> = {
    ok: ACCENT.green,
    warn: ACCENT.amber,
    err: ACCENT.rose,
    info: ACCENT.cyan,
    sys: ACCENT.violet,
    warm: ACCENT.blue,
    net: ACCENT.mint,
  };
  if (!supportsColor()) return `[${label}]`;
  const [r, g, b] = map[tone] || map.info;
  return (
    gray(600, '[') +
    `\x1b[38;2;${r};${g};${b}m${label}\x1b[0m` +
    gray(600, ']')
  );
}

/**
 * Soft monochrome line color (whole line).
 */
export function softLine(line: string, lightness = 0.55): string {
  if (!supportsColor() || !line.length) return line;
  const r = Math.round(113 + (228 - 113) * lightness);
  const g = Math.round(113 + (228 - 113) * lightness);
  const b = Math.round(122 + (231 - 122) * lightness);
  return `\x1b[38;2;${r};${g};${b}m${line}\x1b[0m`;
}

/** Gray→white wash by line index for logo build */
export function gradientByIndex(line: string, index: number, total: number): string {
  const t = total <= 1 ? 0.6 : index / Math.max(total - 1, 1);
  return softLine(line, 0.3 + 0.65 * t);
}

/** Cool cyan→white wash for MANUS PROXY banner */
export function bannerLine(line: string, index: number, total: number): string {
  if (!supportsColor() || !line.length) return line;
  const t = total <= 1 ? 0.5 : index / Math.max(total - 1, 1);
  // zinc-400 → sky-200
  const r = Math.round(161 + (186 - 161) * t);
  const g = Math.round(161 + (230 - 161) * t);
  const b = Math.round(170 + (253 - 170) * t);
  return `\x1b[38;2;${r};${g};${b}m${line}\x1b[0m`;
}

export function separator(width = 56, char = '─'): string {
  const w = Math.max(8, Math.min(width, process.stdout.columns || width));
  return gray(700, char.repeat(w));
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '')
    .replace(/\x1b\]8;;\x07/g, '');
}

export function center(text: string, width?: number): string {
  const w = width || Math.min(process.stdout.columns || 80, 80);
  const plain = stripAnsi(text);
  const pad = Math.max(0, Math.floor((w - plain.length) / 2));
  return ' '.repeat(pad) + text;
}

export function leftPad(text: string, pad = 2): string {
  return ' '.repeat(pad) + text;
}

/** Simple spinner frames */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
