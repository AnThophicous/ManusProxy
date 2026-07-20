import { v4 as uuidv4 } from 'uuid';
import type {
  ChatMessage,
  MessageToolCall,
  OpenAITool,
  ResponseFunctionCallItem,
  ResponseMessageItem,
  ResponseObject,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseUsage,
  ResponsesRequest,
  StreamEvent,
} from './types.ts';
import { SequenceCounter } from './sse.ts';

export function makeResponseId(): string {
  return `resp_${uuidv4().replace(/-/g, '')}`;
}

export function makeMessageId(): string {
  return `msg_${uuidv4().replace(/-/g, '')}`;
}

export function makeFunctionCallId(): string {
  return `fc_${uuidv4().replace(/-/g, '')}`;
}

export function makeReasoningId(): string {
  return `rs_${uuidv4().replace(/-/g, '')}`;
}

export function mapChatUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}): ResponseUsage {
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens,
  };
}

export function resolvePreviousId(body: ResponsesRequest): string | null {
  return body.previous_response_id ?? body.last_response_id ?? null;
}

export function responsesInputToMessages(
  body: ResponsesRequest,
  priorMessages: ChatMessage[] = []
): ChatMessage[] {
  const messages: ChatMessage[] = [...priorMessages];

  if (body.instructions) {
    const hasSystem = messages.some((m) => m.role === 'system' || m.role === 'developer');
    if (!hasSystem) messages.unshift({ role: 'system', content: body.instructions });
    else messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (input == null) return messages;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;

    if (rec.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(rec.call_id ?? ''),
        content: typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output),
      });
      continue;
    }

    if (rec.type === 'function_call') {
      const callId = String(rec.call_id ?? rec.id ?? `call_${uuidv4()}`);
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: String(rec.name ?? ''),
              arguments:
                typeof rec.arguments === 'string'
                  ? rec.arguments
                  : JSON.stringify(rec.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }

    if (rec.type === 'reasoning') continue;

    if (rec.role || rec.type === 'message' || rec.type === 'input_text') {
      const role = String(rec.role ?? 'user');
      let content: ChatMessage['content'] = null;

      if (typeof rec.content === 'string') {
        content = rec.content;
      } else if (Array.isArray(rec.content)) {
        content = rec.content.map((part: any) => {
          if (typeof part === 'string') return { type: 'text' as const, text: part };
          if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
            return { type: 'text' as const, text: String(part.text || '') };
          }
          if (part?.type === 'input_image' || part?.type === 'image_url') {
            const url =
              typeof part.image_url === 'string'
                ? part.image_url
                : part.image_url?.url || part.image_url || part.url || '';
            return { type: 'image_url' as const, image_url: { url: String(url) } };
          }
          if (part?.text) return { type: 'text' as const, text: String(part.text) };
          return { type: 'text' as const, text: JSON.stringify(part) };
        });
      } else if (rec.type === 'input_text' && rec.text) {
        content = String(rec.text);
      } else if (rec.content != null) {
        content = JSON.stringify(rec.content);
      }

      if (role === 'assistant' && Array.isArray(rec.tool_calls)) {
        messages.push({
          role: 'assistant',
          content,
          tool_calls: rec.tool_calls as MessageToolCall[],
        });
      } else {
        messages.push({ role, content });
      }
    }
  }

  return messages;
}

export function normalizeResponsesTools(
  tools: ResponsesRequest['tools']
): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .map((t: any) => {
      if (t?.type === 'function' && t.function?.name) {
        return {
          type: 'function' as const,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            strict: t.function.strict,
          },
        };
      }
      if (t?.type === 'function' && t.name) {
        return {
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: t.strict,
          },
        };
      }
      return null;
    })
    .filter(Boolean) as OpenAITool[];
}

export function buildOutputItems(
  text: string,
  reasoning: string,
  toolCalls: MessageToolCall[]
): ResponseOutputItem[] {
  const output: ResponseOutputItem[] = [];

  if (reasoning) {
    const rs: ResponseReasoningItem = {
      id: makeReasoningId(),
      type: 'reasoning',
      content: [],
      summary: [{ type: 'summary_text', text: reasoning }],
    };
    output.push(rs);
  }

  for (const tc of toolCalls) {
    const item: ResponseFunctionCallItem = {
      id: makeFunctionCallId(),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    };
    output.push(item);
  }

  if (text || (!toolCalls.length && !reasoning)) {
    const msg: ResponseMessageItem = {
      id: makeMessageId(),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: text || '', annotations: [] }],
    };
    output.push(msg);
  }

  return output;
}

export function buildResponseObject(params: {
  id: string;
  model: string;
  createdAt: number;
  status: ResponseObject['status'];
  output: ResponseOutputItem[];
  usage: ResponseUsage | null;
  body: ResponsesRequest;
  previousResponseId: string | null;
  sessionId?: string | null;
  incompleteReason?: string | null;
  error?: { code: string; message: string } | null;
}): ResponseObject {
  const outputText = params.output
    .filter((o: any) => o.type === 'message')
    .flatMap((o: any) => o.content || [])
    .filter((c: any) => c.type === 'output_text')
    .map((c: any) => c.text)
    .join('');

  return {
    id: params.id,
    object: 'response',
    created_at: params.createdAt,
    status: params.status,
    completed_at: params.status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    error: params.error ?? null,
    incomplete_details: params.incompleteReason
      ? { reason: params.incompleteReason }
      : null,
    instructions: params.body.instructions ?? null,
    max_output_tokens: params.body.max_output_tokens ?? null,
    model: params.model,
    output: params.output,
    parallel_tool_calls: params.body.parallel_tool_calls ?? true,
    previous_response_id: params.previousResponseId,
    reasoning: { effort: null, summary: null },
    store: params.body.store !== false,
    temperature: params.body.temperature ?? null,
    text: { format: { type: params.body.text?.format?.type || 'text' } },
    tool_choice: params.body.tool_choice ?? 'auto',
    tools: params.body.tools ?? [],
    top_p: params.body.top_p ?? null,
    truncation: 'disabled',
    usage: params.usage,
    user: params.body.user ?? null,
    metadata: params.body.metadata ?? {},
    background: false,
    session_id: params.sessionId ?? params.body.session_id ?? null,
    output_text: outputText,
  };
}

export class ResponsesStreamEmitter {
  private seq = new SequenceCounter();
  private messageId = makeMessageId();
  private reasoningId = makeReasoningId();
  private openedMessage = false;
  private openedReasoning = false;
  private text = '';
  private reasoning = '';
  private toolItems = new Map<
    number,
    { itemId: string; callId: string; name: string; arguments: string }
  >();
  private output: ResponseOutputItem[] = [];

  constructor(
    private responseId: string,
    private model: string,
    private createdAt: number,
    private body: ResponsesRequest,
    private previousResponseId: string | null,
    private sessionId: string | null,
    private write: (event: string, payload: StreamEvent) => Promise<void>
  ) {}

  private skeleton(
    status: ResponseObject['status'],
    usage: ResponseUsage | null = null
  ): ResponseObject {
    return buildResponseObject({
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status,
      output: this.output,
      usage,
      body: this.body,
      previousResponseId: this.previousResponseId,
      sessionId: this.sessionId,
    });
  }

  async emitCreated(): Promise<void> {
    const response = this.skeleton('in_progress');
    await this.write('response.created', {
      type: 'response.created',
      sequence_number: this.seq.next(),
      response,
    });
    await this.write('response.in_progress', {
      type: 'response.in_progress',
      sequence_number: this.seq.next(),
      response,
    });
  }

  /** Stream Manus thinking as Responses reasoning item + summary deltas */
  async emitReasoningDelta(delta: string): Promise<void> {
    if (!delta) return;
    if (!this.openedReasoning) {
      this.openedReasoning = true;
      const item: ResponseReasoningItem = {
        id: this.reasoningId,
        type: 'reasoning',
        content: [],
        summary: [],
      };
      await this.write('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: this.seq.next(),
        output_index: 0,
        item,
      });
      await this.write('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        sequence_number: this.seq.next(),
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    this.reasoning += delta;
    await this.write('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      sequence_number: this.seq.next(),
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      delta,
    });
    // Also emit a manus-friendly alias for clients that listen for it
    await this.write('manus.thinking.delta', {
      type: 'manus.thinking.delta',
      sequence_number: this.seq.next(),
      delta,
      text: this.reasoning,
    });
  }

  async emitTextDelta(delta: string): Promise<void> {
    if (!delta) return;
    // Message sits after reasoning in output_index when reasoning opened first
    const outputIndex = this.openedReasoning ? 1 : 0;
    if (!this.openedMessage) {
      this.openedMessage = true;
      const item: ResponseMessageItem = {
        id: this.messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      };
      await this.write('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: this.seq.next(),
        output_index: outputIndex,
        item,
      });
      await this.write('response.content_part.added', {
        type: 'response.content_part.added',
        sequence_number: this.seq.next(),
        item_id: this.messageId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.text += delta;
    await this.write('response.output_text.delta', {
      type: 'response.output_text.delta',
      sequence_number: this.seq.next(),
      item_id: this.messageId,
      output_index: outputIndex,
      content_index: 0,
      delta,
    });
  }

  async emitToolCalls(toolCalls: MessageToolCall[]): Promise<void> {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const itemId = makeFunctionCallId();
      this.toolItems.set(i, {
        itemId,
        callId: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
      const item: ResponseFunctionCallItem = {
        id: itemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: tc.id,
        name: tc.function.name,
        arguments: '',
      };
      await this.write('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: this.seq.next(),
        output_index: this.openedMessage ? 1 + i : i,
        item,
      });
      await this.write('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        sequence_number: this.seq.next(),
        item_id: itemId,
        output_index: this.openedMessage ? 1 + i : i,
        delta: tc.function.arguments,
      });
      await this.write('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        sequence_number: this.seq.next(),
        item_id: itemId,
        output_index: this.openedMessage ? 1 + i : i,
        arguments: tc.function.arguments,
      });
      await this.write('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: this.seq.next(),
        output_index: this.openedMessage ? 1 + i : i,
        item: { ...item, status: 'completed', arguments: tc.function.arguments },
      });
    }
  }

  async emitCompleted(usage: ResponseUsage | null, toolCalls: MessageToolCall[]): Promise<ResponseObject> {
    this.output = buildOutputItems(this.text, this.reasoning, toolCalls);
    const msgIndex = this.openedReasoning ? 1 : 0;

    if (this.openedReasoning) {
      await this.write('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        sequence_number: this.seq.next(),
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        text: this.reasoning,
      });
      await this.write('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        sequence_number: this.seq.next(),
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: this.reasoning },
      });
      await this.write('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: this.seq.next(),
        output_index: 0,
        item: {
          id: this.reasoningId,
          type: 'reasoning',
          content: [],
          summary: [{ type: 'summary_text', text: this.reasoning }],
        },
      });
      await this.write('manus.thinking.done', {
        type: 'manus.thinking.done',
        sequence_number: this.seq.next(),
        text: this.reasoning,
      });
    }

    if (this.openedMessage) {
      await this.write('response.output_text.done', {
        type: 'response.output_text.done',
        sequence_number: this.seq.next(),
        item_id: this.messageId,
        output_index: msgIndex,
        content_index: 0,
        text: this.text,
      });
      await this.write('response.content_part.done', {
        type: 'response.content_part.done',
        sequence_number: this.seq.next(),
        item_id: this.messageId,
        output_index: msgIndex,
        content_index: 0,
        part: { type: 'output_text', text: this.text, annotations: [] },
      });
      await this.write('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: this.seq.next(),
        output_index: msgIndex,
        item: {
          id: this.messageId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: this.text, annotations: [] }],
        },
      });
    }
    const response = this.skeleton('completed', usage);
    if (usage && this.reasoning) {
      usage.output_tokens_details = {
        ...usage.output_tokens_details,
        reasoning_tokens: Math.ceil(this.reasoning.length / 4),
      };
    }
    await this.write('response.completed', {
      type: 'response.completed',
      sequence_number: this.seq.next(),
      response,
    });
    return response;
  }

  getText(): string {
    return this.text;
  }

  getReasoning(): string {
    return this.reasoning;
  }
}
