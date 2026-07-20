import { v4 as uuidv4 } from 'uuid';
import type { MessageToolCall, OpenAITool } from './types.ts';

const TOOL_CALL_RE =
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const TOOL_CALLS_RE =
  /<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/gi;

export function toolsToSystemPrompt(tools?: OpenAITool[]): string {
  if (!tools?.length) return '';
  const schemas = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters ?? {},
  }));
  return [
    'You have access to the following tools. When you need to call a tool, do NOT describe it in prose.',
    'Emit ONE or MORE blocks exactly like:',
    '<tool_call>',
    '{"name":"tool_name","arguments":{...}}',
    '</tool_call>',
    'You may call multiple tools. After tool results arrive, continue the task.',
    'If no tool is needed, answer normally without tool_call tags.',
    'Available tools JSON:',
    JSON.stringify(schemas, null, 2),
  ].join('\n');
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
