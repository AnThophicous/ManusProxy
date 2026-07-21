import { v4 as uuidv4 } from 'uuid';
import type { MessageToolCall, OpenAITool } from './types.ts';

const TOOL_CALL_RE =
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const TOOL_CALLS_RE =
  /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/gi;

export type ToolsPromptOptions = {
  /** True when the HTTP client (OpenCode / Codex / etc.) sent tools */
  hasClientTools?: boolean;
  /** Builtin local tools are also in the list */
  hasBuiltinTools?: boolean;
};

/**
 * Protocol for host-side tools (OpenCode, Codex, Cursor, our builtins).
 * Manus cloud sandbox is NOT the user's machine.
 */
export function toolsToSystemPrompt(
  tools?: OpenAITool[],
  opts: ToolsPromptOptions = {}
): string {
  if (!tools?.length) return '';

  const schemas = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters ?? {},
  }));

  const hostBits: string[] = [
    '[HOST TOOLS PROTOCOL — MANDATORY]',
    'You are connected to a LOCAL host agent (OpenCode, Codex, Cursor, or ManusProxy builtins).',
    'The Manus cloud VM / sandbox (/home/ubuntu, /tmp on Manus, remote desktop, "Build") is NOT the user computer.',
    'Anything you write only on the Manus sandbox is INVISIBLE to the user and is a FAILURE.',
    '',
    'CRITICAL TIMING:',
    '- Do NOT write a long plan and stop.',
    '- Do NOT say "vou verificar o ambiente" and end the turn.',
    '- On coding/file tasks, your FIRST or SECOND message MUST include real <tool_call> blocks.',
    '- Planning without tool_calls is incomplete work.',
    '',
    'To create, edit, read, search, or run anything on the USER machine you MUST emit tool calls.',
    'Do NOT describe a tool call in prose. Do NOT say "file saved at /home/ubuntu/..." as a deliverable.',
    'Emit ONE or MORE blocks exactly like:',
    '<tool_call>',
    '{"name":"tool_name","arguments":{...}}',
    '</tool_call>',
    'You may emit multiple <tool_call> blocks. After tool results arrive, continue the task.',
    'If no tool is needed (pure Q&A), answer normally without tool_call tags.',
    '',
  ];

  if (opts.hasClientTools) {
    hostBits.push(
      'The client (OpenCode/Codex/etc.) owns the real workspace on the user PC.',
      'Prefer the client tools for file and shell work. Those tool_calls are executed by the client, not by Manus.',
      'Never substitute Manus agent "Build" / remote file creation for a host tool_call.',
      ''
    );
  }

  if (opts.hasBuiltinTools) {
    hostBits.push(
      'Builtin tools (workspace, write_file, read_file, search_lines, …) write under the proxy local workspace on the user machine.',
      'Use them when the client did not provide an equivalent tool, or when the task is pure local sandbox via the proxy.',
      ''
    );
  }

  hostBits.push(
    'Available tools JSON (ONLY these work for the user):',
    JSON.stringify(schemas, null, 2),
    '[/HOST TOOLS PROTOCOL]'
  );

  return hostBits.join('\n');
}

export function parseToolCallsFromText(text: string): {
  cleanText: string;
  toolCalls: MessageToolCall[];
} {
  const toolCalls: MessageToolCall[] = [];
  let clean = text;

  // <tool_calls>[...]</tool_calls>
  clean = clean.replace(TOOL_CALLS_RE, (_m, inner: string) => {
    try {
      const parsed = JSON.parse(inner.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        const tc = normalizeToolItem(item);
        if (tc) toolCalls.push(tc);
      }
    } catch {
      /* ignore */
    }
    return '';
  });

  // <tool_call>...</tool_call>
  clean = clean.replace(TOOL_CALL_RE, (_m, inner: string) => {
    try {
      const item = JSON.parse(inner.trim());
      const tc = normalizeToolItem(item);
      if (tc) toolCalls.push(tc);
    } catch {
      /* ignore */
    }
    return '';
  });

  // Fallback: ```tool_call\n{...}\n```
  clean = clean.replace(/```tool_call\s*([\s\S]*?)```/gi, (_m, inner: string) => {
    try {
      const item = JSON.parse(inner.trim());
      const tc = normalizeToolItem(item);
      if (tc) toolCalls.push(tc);
    } catch {
      /* ignore */
    }
    return '';
  });

  // Fallback: invoke tool_name with {...} loose patterns some models emit
  clean = clean.replace(
    /(?:call|invoke|run)_tool\s*[:=]\s*(\{[\s\S]*?\})/gi,
    (_m, inner: string) => {
      try {
        const item = JSON.parse(inner.trim());
        const tc = normalizeToolItem(item);
        if (tc) toolCalls.push(tc);
      } catch {
        /* ignore */
      }
      return '';
    }
  );

  return { cleanText: clean.trim(), toolCalls };
}

function normalizeToolItem(item: unknown): MessageToolCall | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const name = String(rec.name || (rec.function as any)?.name || '');
  if (!name) return null;
  let args = rec.arguments ?? rec.args ?? (rec.function as any)?.arguments ?? {};
  if (typeof args !== 'string') args = JSON.stringify(args ?? {});
  return {
    id: String(rec.id || rec.call_id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`),
    type: 'function',
    function: {
      name,
      arguments: args as string,
    },
  };
}

export function toolCallsToSseDeltas(
  toolCalls: MessageToolCall[]
): Array<{
  index: number;
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

/** Paths that usually mean Manus remote sandbox, not user host */
export function looksLikeManusSandboxPath(text: string): boolean {
  return /\/home\/ubuntu\b|\/home\/manus\b|\\\\home\\\\ubuntu\b/i.test(text || '');
}
