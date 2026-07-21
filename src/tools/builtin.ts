/**
 * Builtin tools for Manus agent work.
 * All file tools are sandboxed under MANUS_WORKSPACE (default: ./workspace).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpenAITool } from '../openai/types.ts';
import { log } from '../cli/log-bus.ts';

// ─── Workspace root ──────────────────────────────────────────

export function getWorkspaceRoot(): string {
  const raw =
    process.env.MANUS_WORKSPACE?.trim() ||
    process.env.WORKSPACE?.trim() ||
    path.resolve(process.cwd(), 'workspace');
  const root = path.resolve(raw);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve path inside workspace; throws if escapes sandbox */
export function resolveInWorkspace(userPath: string): string {
  const root = getWorkspaceRoot();
  const cleaned = String(userPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  // allow absolute if already under root
  let target: string;
  if (path.isAbsolute(userPath) || /^[A-Za-z]:[\\/]/.test(userPath)) {
    target = path.resolve(userPath);
  } else {
    target = path.resolve(root, cleaned || '.');
  }
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path outside workspace: ${userPath}`);
  }
  return target;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function walkDir(
  dir: string,
  root: string,
  opts: { maxFiles: number; maxDepth: number; depth: number },
  out: Array<{ path: string; type: 'file' | 'dir'; size?: number }>
): void {
  if (out.length >= opts.maxFiles || opts.depth > opts.maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= opts.maxFiles) break;
    // skip heavy/hidden junk
    if (
      ent.name === 'node_modules' ||
      ent.name === '.git' ||
      ent.name === 'dist' ||
      ent.name === '.cache'
    ) {
      continue;
    }
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      out.push({ path: rel + '/', type: 'dir' });
      walkDir(full, root, { ...opts, depth: opts.depth + 1 }, out);
    } else if (ent.isFile()) {
      let size: number | undefined;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      out.push({ path: rel, type: 'file', size });
    }
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ─── Tool schemas ────────────────────────────────────────────

export const BUILTIN_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'workspace',
      description:
        'Get the local workspace absolute path and list all child files/dirs (tree). Use first to know where to read/write.',
      parameters: {
        type: 'object',
        properties: {
          subpath: {
            type: 'string',
            description: 'Optional subfolder relative to workspace root (default: root).',
          },
          max_files: {
            type: 'number',
            description: 'Max entries to list (default 500).',
          },
          max_depth: {
            type: 'number',
            description: 'Max directory depth (default 8).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write text content to a file inside the workspace. Creates parent dirs. Overwrites by default.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside workspace, e.g. src/app.ts',
          },
          content: {
            type: 'string',
            description: 'Full file content to write.',
          },
          append: {
            type: 'boolean',
            description: 'If true, append instead of overwrite.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Supports optional line offset/limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside workspace.' },
          offset: {
            type: 'number',
            description: '1-based start line (optional).',
          },
          limit: {
            type: 'number',
            description: 'Max lines to return (optional).',
          },
          max_chars: {
            type: 'number',
            description: 'Hard cap on characters returned (default 80000).',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List immediate children of a directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory relative to workspace (default: .).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mkdir',
      description: 'Create a directory (and parents) inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or empty directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: {
            type: 'boolean',
            description: 'If true, delete directories recursively.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace exact occurrences of old_string with new_string in a workspace file. Fails if old_string not found.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default false = first only).',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search file names and/or file contents under the workspace. Returns matching paths with optional snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring or simple regex (if regex=true).',
          },
          path: {
            type: 'string',
            description: 'Subfolder to search (default workspace root).',
          },
          mode: {
            type: 'string',
            enum: ['name', 'content', 'both'],
            description: 'Search filenames, contents, or both (default both).',
          },
          regex: { type: 'boolean' },
          max_results: { type: 'number' },
          glob: {
            type: 'string',
            description: 'Optional extension filter, e.g. .ts or .md',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_lines',
      description:
        'Search exactly inside ONE file and return matching lines with 1-based line numbers. Like grep -n on a single file. Supports context lines before/after.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path relative to workspace.',
          },
          query: {
            type: 'string',
            description: 'Substring to find (or regex if regex=true).',
          },
          regex: {
            type: 'boolean',
            description: 'Treat query as JavaScript regex (default false).',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Default false (case-insensitive).',
          },
          context_before: {
            type: 'number',
            description: 'Lines of context before each match (default 0).',
          },
          context_after: {
            type: 'number',
            description: 'Lines of context after each match (default 0).',
          },
          max_matches: {
            type: 'number',
            description: 'Max matching lines to return (default 50).',
          },
        },
        required: ['path', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Stat a path: exists, type, size, mtime.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manual_fetch',
      description:
        'Fetch a URL and return page/API content. HTML is converted to readable text; JSON/text returned as-is. Use for docs, APIs, research.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: {
            type: 'number',
            description: 'Max characters of body (default 12000, max 100000).',
          },
          raw_html: {
            type: 'boolean',
            description: 'If true, return raw HTML instead of text extract.',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST'],
            description: 'HTTP method (default GET).',
          },
          body: {
            type: 'string',
            description: 'Optional JSON/text body for POST.',
          },
          headers: {
            type: 'object',
            description: 'Optional extra headers as string map.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Move or rename a file/directory inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
  },
];

// ─── Executor ────────────────────────────────────────────────

export async function executeBuiltinTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  log.info('TOOL', name, 'executing', args);
  try {
    switch (name) {
      case 'workspace': {
        const root = getWorkspaceRoot();
        const sub = typeof args.subpath === 'string' ? args.subpath : '.';
        const start = resolveInWorkspace(sub);
        if (!fs.existsSync(start)) {
          return JSON.stringify({ error: 'path not found', root, path: sub });
        }
        const maxFiles = Math.min(Number(args.max_files) || 500, 2000);
        const maxDepth = Math.min(Number(args.max_depth) || 8, 20);
        const children: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = [];
        const stat = fs.statSync(start);
        if (stat.isDirectory()) {
          walkDir(start, root, { maxFiles, maxDepth, depth: 0 }, children);
        } else {
          children.push({
            path: path.relative(root, start).replace(/\\/g, '/'),
            type: 'file',
            size: stat.size,
          });
        }
        return JSON.stringify(
          {
            workspace_root: root,
            path: path.relative(root, start).replace(/\\/g, '/') || '.',
            count: children.length,
            truncated: children.length >= maxFiles,
            children,
          },
          null,
          2
        );
      }

      case 'write_file': {
        const target = resolveInWorkspace(String(args.path || ''));
        const content = String(args.content ?? '');
        const append = Boolean(args.append);
        ensureParentDir(target);
        if (append) fs.appendFileSync(target, content, 'utf8');
        else fs.writeFileSync(target, content, 'utf8');
        const st = fs.statSync(target);
        return JSON.stringify({
          ok: true,
          path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
          absolute: target,
          bytes: st.size,
          mode: append ? 'append' : 'write',
        });
      }

      case 'read_file': {
        const target = resolveInWorkspace(String(args.path || ''));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`File not found: ${args.path}`);
        }
        let text = fs.readFileSync(target, 'utf8');
        const lines = text.split(/\r?\n/);
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = args.limit != null ? Math.max(1, Number(args.limit)) : undefined;
        let slice = lines;
        if (offset > 1 || limit != null) {
          slice = lines.slice(offset - 1, limit != null ? offset - 1 + limit : undefined);
          text = slice.join('\n');
        }
        const maxChars = Math.min(Number(args.max_chars) || 80_000, 200_000);
        const truncated = text.length > maxChars;
        return JSON.stringify({
          ok: true,
          path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
          absolute: target,
          lines: slice.length,
          total_lines: lines.length,
          offset,
          truncated,
          content: truncated ? text.slice(0, maxChars) : text,
        });
      }

      case 'list_dir': {
        const target = resolveInWorkspace(String(args.path || '.'));
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          throw new Error(`Not a directory: ${args.path || '.'}`);
        }
        const root = getWorkspaceRoot();
        const items = fs.readdirSync(target, { withFileTypes: true }).map((ent) => {
          const full = path.join(target, ent.name);
          let size: number | undefined;
          try {
            if (ent.isFile()) size = fs.statSync(full).size;
          } catch {
            /* ignore */
          }
          return {
            name: ent.name,
            path: path.relative(root, full).replace(/\\/g, '/'),
            type: ent.isDirectory() ? 'dir' : 'file',
            size,
          };
        });
        return JSON.stringify({
          ok: true,
          path: path.relative(root, target).replace(/\\/g, '/') || '.',
          count: items.length,
          items,
        });
      }

      case 'mkdir': {
        const target = resolveInWorkspace(String(args.path || ''));
        fs.mkdirSync(target, { recursive: true });
        return JSON.stringify({
          ok: true,
          path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
          absolute: target,
        });
      }

      case 'delete_path': {
        const target = resolveInWorkspace(String(args.path || ''));
        if (!fs.existsSync(target)) throw new Error(`Not found: ${args.path}`);
        const recursive = Boolean(args.recursive);
        fs.rmSync(target, { recursive, force: false });
        return JSON.stringify({
          ok: true,
          deleted: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
        });
      }

      case 'replace_in_file': {
        const target = resolveInWorkspace(String(args.path || ''));
        if (!fs.existsSync(target)) throw new Error(`File not found: ${args.path}`);
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) throw new Error('old_string is empty');
        let text = fs.readFileSync(target, 'utf8');
        if (!text.includes(oldStr)) {
          throw new Error('old_string not found in file');
        }
        const replaceAll = Boolean(args.replace_all);
        let count = 0;
        if (replaceAll) {
          const parts = text.split(oldStr);
          count = parts.length - 1;
          text = parts.join(newStr);
        } else {
          text = text.replace(oldStr, newStr);
          count = 1;
        }
        fs.writeFileSync(target, text, 'utf8');
        return JSON.stringify({
          ok: true,
          path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
          replacements: count,
        });
      }

      case 'search_files': {
        const root = getWorkspaceRoot();
        const start = resolveInWorkspace(String(args.path || '.'));
        const query = String(args.query || '');
        if (!query) throw new Error('query required');
        const mode = String(args.mode || 'both');
        const useRegex = Boolean(args.regex);
        const maxResults = Math.min(Number(args.max_results) || 40, 200);
        const glob = typeof args.glob === 'string' ? args.glob.toLowerCase() : '';
        const re = useRegex ? new RegExp(query, 'i') : null;
        const match = (s: string) =>
          re ? re.test(s) : s.toLowerCase().includes(query.toLowerCase());

        const all: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = [];
        if (fs.statSync(start).isDirectory()) {
          walkDir(start, root, { maxFiles: 3000, maxDepth: 12, depth: 0 }, all);
        }
        const hits: Array<{ path: string; match: 'name' | 'content'; snippet?: string }> =
          [];

        for (const item of all) {
          if (hits.length >= maxResults) break;
          if (item.type !== 'file') continue;
          if (glob && !item.path.toLowerCase().endsWith(glob.replace(/^\*/, ''))) continue;

          const base = path.basename(item.path);
          if ((mode === 'name' || mode === 'both') && match(base)) {
            hits.push({ path: item.path, match: 'name' });
            continue;
          }
          if (mode === 'content' || mode === 'both') {
            try {
              const full = path.join(root, item.path);
              // skip huge/binary-ish
              if ((item.size || 0) > 1_500_000) continue;
              const text = fs.readFileSync(full, 'utf8');
              if (match(text)) {
                let snippet: string | undefined;
                const idx = useRegex
                  ? text.search(re!)
                  : text.toLowerCase().indexOf(query.toLowerCase());
                if (idx >= 0) {
                  snippet = text.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, ' ');
                }
                hits.push({ path: item.path, match: 'content', snippet });
              }
            } catch {
              /* binary or unreadable */
            }
          }
        }
        return JSON.stringify({
          ok: true,
          workspace_root: root,
          query,
          count: hits.length,
          hits,
        });
      }

      case 'search_lines': {
        const target = resolveInWorkspace(String(args.path || ''));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`File not found: ${args.path}`);
        }
        const query = String(args.query || '');
        if (!query) throw new Error('query required');
        const caseSensitive = Boolean(args.case_sensitive);
        const useRegex = Boolean(args.regex);
        const ctxBefore = Math.min(Math.max(0, Number(args.context_before) || 0), 20);
        const ctxAfter = Math.min(Math.max(0, Number(args.context_after) || 0), 20);
        const maxMatches = Math.min(Number(args.max_matches) || 50, 500);

        const text = fs.readFileSync(target, 'utf8');
        const lines = text.split(/\r?\n/);
        let re: RegExp | null = null;
        if (useRegex) {
          re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        }
        const matchesQuery = (line: string) => {
          if (re) {
            re.lastIndex = 0;
            return re.test(line);
          }
          if (caseSensitive) return line.includes(query);
          return line.toLowerCase().includes(query.toLowerCase());
        };

        const matches: Array<{
          line: number;
          text: string;
          context_before?: Array<{ line: number; text: string }>;
          context_after?: Array<{ line: number; text: string }>;
        }> = [];

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) break;
          if (!matchesQuery(lines[i])) continue;
          const entry: (typeof matches)[0] = {
            line: i + 1,
            text: lines[i],
          };
          if (ctxBefore > 0) {
            entry.context_before = [];
            for (let j = Math.max(0, i - ctxBefore); j < i; j++) {
              entry.context_before.push({ line: j + 1, text: lines[j] });
            }
          }
          if (ctxAfter > 0) {
            entry.context_after = [];
            for (let j = i + 1; j <= Math.min(lines.length - 1, i + ctxAfter); j++) {
              entry.context_after.push({ line: j + 1, text: lines[j] });
            }
          }
          matches.push(entry);
        }

        return JSON.stringify(
          {
            ok: true,
            path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
            absolute: target,
            query,
            total_lines: lines.length,
            match_count: matches.length,
            truncated: matches.length >= maxMatches,
            matches,
          },
          null,
          2
        );
      }

      case 'file_info': {
        const target = resolveInWorkspace(String(args.path || ''));
        if (!fs.existsSync(target)) {
          return JSON.stringify({
            ok: true,
            exists: false,
            path: args.path,
          });
        }
        const st = fs.statSync(target);
        return JSON.stringify({
          ok: true,
          exists: true,
          path: path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/'),
          absolute: target,
          type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }

      case 'manual_fetch': {
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs allowed');
        const maxChars = Math.min(Number(args.max_chars) || 12_000, 100_000);
        const method = String(args.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
        const rawHtml = Boolean(args.raw_html);
        const headers: Record<string, string> = {
          'user-agent':
            'Mozilla/5.0 (compatible; ManusProxy/0.3; +local-tools)',
          accept: 'text/html,application/json,text/plain,*/*',
        };
        if (args.headers && typeof args.headers === 'object') {
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            if (v != null) headers[k] = String(v);
          }
        }
        const init: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(25_000),
        };
        if (method === 'POST' && args.body != null) {
          init.body = String(args.body);
          if (!headers['content-type']) headers['content-type'] = 'application/json';
        }
        const res = await fetch(url, init);
        const ct = res.headers.get('content-type') || '';
        const raw = await res.text();
        let body: string;
        if (!rawHtml && /html/i.test(ct)) {
          body = htmlToText(raw);
        } else {
          body = raw;
        }
        const truncated = body.length > maxChars;
        return JSON.stringify({
          ok: res.ok,
          status: res.status,
          url: res.url || url,
          content_type: ct,
          truncated,
          chars: Math.min(body.length, maxChars),
          body: truncated ? body.slice(0, maxChars) : body,
        });
      }

      case 'move_path': {
        const from = resolveInWorkspace(String(args.from || ''));
        const to = resolveInWorkspace(String(args.to || ''));
        if (!fs.existsSync(from)) throw new Error(`Not found: ${args.from}`);
        ensureParentDir(to);
        fs.renameSync(from, to);
        const root = getWorkspaceRoot();
        return JSON.stringify({
          ok: true,
          from: path.relative(root, from).replace(/\\/g, '/'),
          to: path.relative(root, to).replace(/\\/g, '/'),
        });
      }

      default:
        throw new Error(`Unknown builtin tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('TOOL', name, message);
    return JSON.stringify({ error: message, tool: name });
  }
}

/**
 * Merge host tools.
 * - Client tools (OpenCode / Codex / Cursor) always win on name collision.
 * - Builtin workspace tools are optional local helpers (MANUS_BUILTIN_TOOLS=0 to disable).
 * Client tools are listed first so the model sees them as primary.
 */
export function mergeTools(clientTools?: OpenAITool[]): OpenAITool[] {
  const wantBuiltins = process.env.MANUS_BUILTIN_TOOLS !== '0' && process.env.MANUS_BUILTIN_TOOLS !== 'false';
  const map = new Map<string, OpenAITool>();
  // Builtins first into map, then client overwrites same names
  if (wantBuiltins) {
    for (const t of BUILTIN_TOOLS) map.set(t.function.name, t);
  }
  for (const t of clientTools || []) map.set(t.function.name, t);

  // Stable order: client tools first, then remaining builtins
  const out: OpenAITool[] = [];
  const seen = new Set<string>();
  for (const t of clientTools || []) {
    const name = t.function.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(map.get(name)!);
  }
  if (wantBuiltins) {
    for (const t of BUILTIN_TOOLS) {
      const name = t.function.name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(map.get(name)!);
    }
  }
  return out;
}

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOLS.some((t) => t.function.name === name);
}

export function builtinsEnabled(): boolean {
  return process.env.MANUS_BUILTIN_TOOLS !== '0' && process.env.MANUS_BUILTIN_TOOLS !== 'false';
}
