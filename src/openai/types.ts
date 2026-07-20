export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string; image_url_object?: { url: string } }
  | { type: string; text?: string; image_url?: { url: string } | string; [k: string]: unknown };

export type MessageToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer' | string;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: MessageToolCall[];
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
};

export type OpenAIChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  account?: string;
  user?: string;
  /** Continue a Manus session explicitly */
  session_id?: string;
  /** Alias for session reuse */
  manus_session_id?: string;
};

export type OpenAIChatChoice = {
  index: number;
  message?: {
    role: 'assistant';
    content: string | null;
    /** Manus thinking — OpenAI-compat field used by many clients */
    reasoning_content?: string | null;
    /** Alias some SDKs read */
    reasoning?: string | null;
    tool_calls?: MessageToolCall[];
  };
  delta?: {
    role?: 'assistant';
    content?: string | null;
    /** Streamed thinking tokens */
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
};

export type OpenAIChatResponse = {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Manus / client session for continuity */
  session_id?: string | null;
  /**
   * Manus paused waiting for human (HITL).
   * Continue with same session_id / previous_response_id + next user message.
   */
  requires_action?: boolean;
  requires_action_detail?: {
    type: 'awaiting_user_input';
    prompt?: string;
    reason?: string;
  };
  /** Stream/run was cancelled by client */
  cancelled?: boolean;
};

// ─── Responses API ───────────────────────────────────────────

export type ResponsesRequest = {
  model: string;
  input?: string | Array<Record<string, unknown>>;
  instructions?: string;
  stream?: boolean;
  store?: boolean;
  previous_response_id?: string | null;
  /** Alias used by some clients */
  last_response_id?: string | null;
  session_id?: string | null;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  user?: string;
  metadata?: Record<string, unknown>;
  text?: { format?: { type: string } };
  account?: string;
};

export type ResponseUsage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

export type ResponseMessageItem = {
  id: string;
  type: 'message';
  status: 'completed' | 'in_progress';
  role: 'assistant' | 'user';
  content: Array<{ type: 'output_text' | 'input_text'; text: string; annotations?: unknown[] }>;
};

export type ResponseFunctionCallItem = {
  id: string;
  type: 'function_call';
  status: 'completed' | 'in_progress';
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponseReasoningItem = {
  id: string;
  type: 'reasoning';
  content: unknown[];
  summary: Array<{ type: 'summary_text'; text: string }>;
};

export type ResponseOutputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseReasoningItem;

export type ResponseObject = {
  id: string;
  object: 'response';
  created_at: number;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete';
  completed_at: number | null;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: null; summary: null };
  store: boolean;
  temperature: number | null;
  text: { format: { type: string } };
  tool_choice: unknown;
  tools: unknown[];
  top_p: number | null;
  truncation: string;
  usage: ResponseUsage | null;
  user: string | null;
  metadata: Record<string, unknown>;
  background: boolean;
  session_id: string | null;
  /** Convenience field some SDKs read */
  output_text?: string;
};

export type StreamEvent = {
  type: string;
  sequence_number: number;
  [k: string]: unknown;
};

// ─── Content helpers ─────────────────────────────────────────

export type ExtractedContent = {
  text: string;
  images: Array<{ dataUrl: string; mime: string }>;
};

export function extractContentParts(content: ChatMessage['content']): ExtractedContent {
  const images: Array<{ dataUrl: string; mime: string }> = [];
  if (content == null) return { text: '', images };
  if (typeof content === 'string') return { text: content, images };

  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (part.type === 'text' || part.type === 'input_text') {
      if (part.text) texts.push(part.text);
      continue;
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      let url = '';
      if (typeof part.image_url === 'string') url = part.image_url;
      else if (part.image_url && typeof part.image_url === 'object' && 'url' in part.image_url) {
        url = String((part.image_url as { url: string }).url || '');
      }
      if (!url && (part as { image_url_object?: { url?: string } }).image_url_object?.url) {
        url = String((part as { image_url_object: { url: string } }).image_url_object.url);
      }
      if (url.startsWith('data:image')) {
        const mime = url.slice(5, url.indexOf(';')) || 'image/png';
        images.push({ dataUrl: url, mime });
      } else if (url) {
        // remote URL — pass through as image url content
        images.push({ dataUrl: url, mime: 'image/url' });
      }
      continue;
    }
    if ('text' in part && part.text) texts.push(String(part.text));
  }
  return { text: texts.join('\n'), images };
}

export function messageContentToText(content: ChatMessage['content']): string {
  return extractContentParts(content).text;
}

/**
 * Flatten for a *new* Manus session (no prior context on server).
 * Prefer session reuse + only latest turn when possible.
 */
export function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const text = messageContentToText(m.content).trim();
      parts.push(
        `[tool_result id=${m.tool_call_id || '?'}]\n${text || JSON.stringify(m.content)}`
      );
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      parts.push(
        `[assistant_tool_calls]\n${JSON.stringify(
          m.tool_calls.map((t) => ({
            id: t.id,
            name: t.function.name,
            arguments: t.function.arguments,
          }))
        )}`
      );
      const text = messageContentToText(m.content).trim();
      if (text) parts.push(text);
      continue;
    }
    const text = messageContentToText(m.content).trim();
    if (!text && extractContentParts(m.content).images.length === 0) continue;
    if (m.role === 'system' || m.role === 'developer') parts.push(`[system]\n${text}`);
    else if (m.role === 'user') parts.push(text);
    else if (m.role === 'assistant') parts.push(`[assistant]\n${text}`);
    else parts.push(`[${m.role}]\n${text}`);
  }
  return parts.join('\n\n');
}

/** Only the *new* user/tool turn — used when reusing Manus session (token saver). */
export function extractLatestTurn(messages: ChatMessage[]): {
  text: string;
  images: Array<{ dataUrl: string; mime: string }>;
  isToolResult: boolean;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') {
      return {
        text: `[tool_result id=${m.tool_call_id || '?'}]\n${messageContentToText(m.content)}`,
        images: [],
        isToolResult: true,
      };
    }
    if (m.role === 'user') {
      const parts = extractContentParts(m.content);
      return { text: parts.text, images: parts.images, isToolResult: false };
    }
  }
  const flat = flattenMessages(messages);
  return { text: flat, images: [], isToolResult: false };
}

export function collectAllImages(messages: ChatMessage[]): Array<{ dataUrl: string; mime: string }> {
  const out: Array<{ dataUrl: string; mime: string }> = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(...extractContentParts(m.content).images);
  }
  return out;
}
