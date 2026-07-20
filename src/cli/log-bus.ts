import { EventEmitter } from 'node:events';

export type LogLevel = 'sys' | 'info' | 'ok' | 'warn' | 'err';

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  tag: string;
  title: string;
  /** One-line summary always visible */
  summary: string;
  /** Expanded detail (JSON / multi-line) */
  detail?: string;
  expanded?: boolean;
};

let seq = 0;
const bus = new EventEmitter();
const entries: LogEntry[] = [];
const MAX = 200;

export function onLog(cb: (e: LogEntry) => void): () => void {
  bus.on('log', cb);
  return () => bus.off('log', cb);
}

export function onExpand(cb: (e: LogEntry) => void): () => void {
  bus.on('expand', cb);
  return () => bus.off('expand', cb);
}

export function getLogs(): LogEntry[] {
  return [...entries];
}

export function pushLog(
  level: LogLevel,
  tag: string,
  title: string,
  summary: string,
  detail?: string | object
): LogEntry {
  const entry: LogEntry = {
    id: `log_${++seq}`,
    ts: Date.now(),
    level,
    tag,
    title,
    summary,
    detail:
      detail == null
        ? undefined
        : typeof detail === 'string'
          ? detail
          : JSON.stringify(detail, null, 2),
    expanded: false,
  };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  bus.emit('log', entry);
  return entry;
}

export function toggleExpand(id: string): LogEntry | null {
  const e = entries.find((x) => x.id === id);
  if (!e) return null;
  e.expanded = !e.expanded;
  bus.emit('expand', e);
  return e;
}

export function expandByIndex(index: number): LogEntry | null {
  const e = entries[index];
  if (!e) return null;
  return toggleExpand(e.id);
}

export const log = {
  sys: (tag: string, title: string, summary: string, detail?: string | object) =>
    pushLog('sys', tag, title, summary, detail),
  info: (tag: string, title: string, summary: string, detail?: string | object) =>
    pushLog('info', tag, title, summary, detail),
  ok: (tag: string, title: string, summary: string, detail?: string | object) =>
    pushLog('ok', tag, title, summary, detail),
  warn: (tag: string, title: string, summary: string, detail?: string | object) =>
    pushLog('warn', tag, title, summary, detail),
  err: (tag: string, title: string, summary: string, detail?: string | object) =>
    pushLog('err', tag, title, summary, detail),
};
