import { v4 as uuidv4 } from 'uuid';
import { getUserInfo } from '../manus/client.ts';
import { sendManusChat, type ManusChatResult } from '../manus/ws.ts';
import { withAutonomy } from '../manus/autonomy.ts';
import { getPreferredAccount } from '../account/pool.ts';
import { storeEncryptedAuth, markAccountReady } from '../account/store.ts';
import {
  ensureAccountWithCredits,
  rotateAccount,
  creditsExhausted,
  readCredits,
} from '../account/rotator.ts';
import { responseStore } from '../store/response-store.ts';
import {
  collectAllImages,
  extractLatestTurn,
  flattenMessages,
  type ChatMessage,
  type MessageToolCall,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
  type OpenAITool,
  type ResponsesRequest,
  type ResponseObject,
} from '../openai/types.ts';
import type { SseWriter } from '../openai/sse.ts';
import {
  parseToolCallsFromText,
  toolsToSystemPrompt,
  toolCallsToSseDeltas,
  looksLikeManusSandboxPath,
} from '../openai/tools.ts';
import {
  executeBuiltinTool,
  isBuiltinTool,
  mergeTools,
  builtinsEnabled,
} from '../tools/builtin.ts';
import { log } from '../cli/log-bus.ts';
import { ThinkingStreamBridge, stripThinkTags } from '../openai/thinking-stream.ts';
import { emitProgressive } from '../openai/progressive.ts';
import {
  buildOutputItems,
  buildResponseObject,
  makeResponseId,
  mapChatUsage,
  normalizeResponsesTools,
  resolvePreviousId,
  responsesInputToMessages,
  ResponsesStreamEmitter,
} from '../openai/responses.ts';
import { getManusAuth } from '../services/playwright.ts';
import {
  isAbortError,
  registerRun,
  unregisterRun,
} from '../runtime/active-runs.ts';

type Continuity = {
  manusSessionId: string | null;
  lastEventId: string | null;
  priorMessages: ChatMessage[];
  accountId: string;
  /** Client-facing chain id (Responses session_id) */
  clientSessionId: string | null;
  /** When true, only send latest turn (server already has context) */
  reuseSession: boolean;
};

type ToolsBundle = {
  tools: OpenAITool[];
  prompt: string;
  hasClientTools: boolean;
  hasBuiltinTools: boolean;
  hasHostTools: boolean;
};

/** Manus shortUIDs are ~22 url-safe alphanumerics */
function looksLikeManusSessionId(id: string): boolean {
  return /^[0-9A-Za-z_-]{16,32}$/.test(id) && !id.includes(' ');
}

/**
 * Resolve Manus session continuity.
 * Priority:
 *  1. previous_response_id / last_response_id → reuse that Manus session
 *  2. manus_session_id explicit → join that Manus session
 *  3. session_id (client chain) → lookup tip in response store
 *  4. new Manus session (still can tag with client session_id for later tips)
 *
 * Token saver: when reusing, we do NOT resend full chat history.
 */
function resolveContinuity(
  accountHint: string | null | undefined,
  opts: {
    previousResponseId?: string | null;
    sessionId?: string | null;
    manusSessionId?: string | null;
  }
): Continuity {
  const accountId = getPreferredAccount(accountHint);
  const clientSessionId = opts.sessionId || null;

  const prevId = opts.previousResponseId;
  if (prevId) {
    const rec = responseStore.get(prevId);
    if (rec) {
      return {
        manusSessionId: rec.manusSessionId,
        lastEventId: rec.manusLastEventId,
        priorMessages: rec.messages,
        accountId: rec.accountId || accountId,
        clientSessionId: rec.response.session_id || clientSessionId || rec.manusSessionId,
        reuseSession: true,
      };
    }
  }

  // Explicit Manus session (only if provided as manus_session_id)
  if (opts.manusSessionId && looksLikeManusSessionId(opts.manusSessionId)) {
    const byManus = responseStore.getByManusSession(opts.manusSessionId);
    return {
      manusSessionId: opts.manusSessionId,
      lastEventId: byManus?.manusLastEventId ?? null,
      priorMessages: byManus?.messages ?? [],
      accountId: byManus?.accountId || accountId,
      clientSessionId: clientSessionId || opts.manusSessionId,
      reuseSession: true,
    };
  }

  // Client session_id → tip in store (must have prior response)
  if (clientSessionId) {
    const tip = responseStore.getTip(clientSessionId);
    if (tip) {
      const rec = responseStore.get(tip);
      if (rec) {
        return {
          manusSessionId: rec.manusSessionId,
          lastEventId: rec.manusLastEventId,
          priorMessages: rec.messages,
          accountId: rec.accountId || accountId,
          clientSessionId,
          reuseSession: true,
        };
      }
    }
    // Also allow clientSessionId that IS a known manus uid
    if (looksLikeManusSessionId(clientSessionId)) {
      const byManus = responseStore.getByManusSession(clientSessionId);
      if (byManus) {
        return {
          manusSessionId: byManus.manusSessionId,
          lastEventId: byManus.manusLastEventId,
          priorMessages: byManus.messages,
          accountId: byManus.accountId || accountId,
          clientSessionId,
          reuseSession: true,
        };
      }
    }
    // New Manus session, but remember client session_id for chain tips
    return {
      manusSessionId: null,
      lastEventId: null,
      priorMessages: [],
      accountId,
      clientSessionId,
      reuseSession: false,
    };
  }

  return {
    manusSessionId: null,
    lastEventId: null,
    priorMessages: [],
    accountId,
    clientSessionId: null,
    reuseSession: false,
  };
}

function assertCreditsOk(result: ManusChatResult): void {
  if (result.creditsExhausted || result.status === 'credits_exhausted') {
    throw new Error(
      stripHostNudgeFrom(result.content) ||
        'Créditos da Manus esgotados nesta conta. Espere o refresh diário, troque de conta (x-manus-account) ou faça upgrade no manus.im.'
    );
  }
}

function stripHostNudgeFrom(text: string): string {
  return (text || '')
    .replace(/\[HOST[^\]]*\][^\n]*/gi, '')
    .replace(/Continue with <tool_call>[\s\S]*?No narration\.[^\n]*/gi, '')
    .trim();
}

async function ensureAuth(accountId: string): Promise<{ accountId: string; rotated: boolean }> {
  let id = accountId;
  let rotated = false;

  // Credit-aware rotation before burn
  try {
    const pick = await ensureAccountWithCredits(id);
    id = pick.accountId;
    rotated = pick.rotated;
    if (pick.rotated) {
      log.ok('ROTATE', id, `using account with credits=${pick.credits.total}`);
    }
    if (creditsExhausted(pick.credits)) {
      // double-check live
      const live = await readCredits(id);
      if (creditsExhausted(live)) {
        throw new Error(
          `Créditos da Manus esgotados (conta=${id}, total=${live.total}). ` +
            `Refresh diário ou faça login em outra conta: npm run login -- --account=outra`
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && /cr[eé]dito|credit/i.test(e.message)) throw e;
    /* continue with original if rotation plumbing failed */
  }

  let user = await getUserInfo(id);
  if (!user.ok) {
    const next = await rotateAccount(id);
    if (next) {
      id = next;
      rotated = true;
      user = await getUserInfo(id);
    }
  }
  if (!user.ok) {
    throw new Error(
      `Manus auth failed (${user.status}) account=${id}. Rode: npm run login -- --account=${id}`
    );
  }
  const body = user.body as {
    email?: string;
    displayname?: string;
    userId?: string;
  };
  markAccountReady(id, {
    email: body.email,
    displayName: body.displayname,
    userId: body.userId,
  });
  try {
    const auth = await getManusAuth(id);
    await storeEncryptedAuth(id, {
      authorization: auth.authorization,
      extras: auth.extras,
      capturedAt: auth.capturedAt,
    });
  } catch {
    /* non-fatal */
  }
  return { accountId: id, rotated };
}

async function runWithToolLoop(opts: {
  prompt: string;
  model: string;
  accountId: string;
  sessionId: string | null;
  lastEventId: string | null;
  images: Array<{ dataUrl: string; mime: string }>;
  tools: OpenAITool[];
  hasHostTools?: boolean;
  signal?: AbortSignal;
  onReady?: (ctl: { stop: () => void; sessionId: string }) => void;
  handlers?: Parameters<typeof sendManusChat>[0]['handlers'];
  maxRounds?: number;
}): Promise<ManusChatResult> {
  const maxRounds = opts.maxRounds ?? 4;
  let prompt = opts.prompt;
  let sessionId = opts.sessionId;
  let lastEventId = opts.lastEventId;
  let last: ManusChatResult | null = null;
  const hasHostTools = opts.hasHostTools ?? opts.tools.length > 0;

  for (let round = 0; round < maxRounds; round++) {
    last = await sendManusChat({
      prompt,
      model: opts.model,
      accountId: opts.accountId,
      sessionId,
      lastEventId,
      images: round === 0 ? opts.images : undefined,
      tools: opts.tools,
      hasHostTools,
      signal: opts.signal,
      onReady: opts.onReady,
      handlers: opts.handlers,
    });

    sessionId = last.sessionId;
    lastEventId = last.lastEventId;

    const { cleanText, toolCalls } = parseToolCallsFromText(last.content);
    if (!toolCalls.length) {
      // Manus sometimes "finishes" with only a cloud sandbox path — nudge once
      if (
        hasHostTools &&
        round === 0 &&
        looksLikeManusSandboxPath(last.content) &&
        !parseToolCallsFromText(last.content).toolCalls.length
      ) {
        log.warn(
          'TOOL',
          'sandbox-path',
          'Manus apontou /home/ubuntu — pedindo reenvio via host tool_call'
        );
        prompt =
          'STOP. You wrote or referenced a Manus sandbox path (/home/ubuntu/…). ' +
          'That is NOT the user machine. Re-do the deliverable by emitting <tool_call> blocks ' +
          'using the host tools listed earlier (OpenCode/Codex/builtins). ' +
          'Do not claim success until tool_calls are emitted.';
        continue;
      }
      return { ...last, content: cleanText || last.content };
    }

    // Execute only builtin tools locally; others returned to client (OpenCode/Codex)
    const builtins = toolCalls.filter((t) => isBuiltinTool(t.function.name));
    const external = toolCalls.filter((t) => !isBuiltinTool(t.function.name));
    if (!builtins.length) {
      // Client-side tools only — keep raw content so outer parseToolCallsFromText works
      return last;
    }

    log.info('TOOL', 'loop', `round ${round + 1} · ${builtins.length} builtin call(s)`);
    const results: string[] = [];
    for (const tc of builtins) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      const out = await executeBuiltinTool(tc.function.name, args);
      results.push(
        `<tool_result name="${tc.function.name}" id="${tc.id}">\n${out}\n</tool_result>`
      );
    }

    if (external.length) {
      // mixed: return so client can finish external tools; keep clean text without tool XML if possible
      return { ...last, content: last.content };
    }

    // Feed results back into same Manus session
    prompt =
      `Tool results from the LOCAL host (use them and finish — do not wait for the user):\n` +
      results.join('\n\n');
  }

  return last!;
}

function toolsPromptFor(clientTools?: OpenAITool[]): ToolsBundle {
  const client = clientTools || [];
  const tools = mergeTools(client);
  const hasClientTools = client.length > 0;
  const hasBuiltinTools =
    builtinsEnabled() && tools.some((t) => isBuiltinTool(t.function.name));
  const prompt = toolsToSystemPrompt(tools, { hasClientTools, hasBuiltinTools });
  return {
    tools,
    prompt,
    hasClientTools,
    hasBuiltinTools,
    hasHostTools: tools.length > 0,
  };
}

function buildOutboundPrompt(
  messages: ChatMessage[],
  continuity: Continuity,
  toolsPrompt: string
): {
  prompt: string;
  images: Array<{ dataUrl: string; mime: string }>;
} {
  if (continuity.reuseSession && continuity.manusSessionId) {
    // TOKEN SAVER: only latest user/tool turn + tools + autonomy
    // Tools protocol FIRST so Manus does not skip host tools
    const latest = extractLatestTurn(messages);
    const core = toolsPrompt
      ? `${toolsPrompt}\n\n${latest.text}`
      : latest.text;
    // Re-inject autonomy every turn so long sessions don't "forget"
    return { prompt: withAutonomy(core), images: latest.images };
  }

  // New session: full flatten + tools + autonomy (tools protocol first)
  const text = flattenMessages(messages);
  const images = collectAllImages(messages);
  const core = toolsPrompt ? `${toolsPrompt}\n\n${text}` : text;
  return { prompt: withAutonomy(core), images };
}

function persistContinuity(opts: {
  responseId: string;
  model: string;
  chainSessionId: string;
  manusSessionId: string;
  lastEventId: string | null;
  accountId: string;
  messages: ChatMessage[];
  text: string;
  status: ResponseObject['status'];
  incompleteReason?: string | null;
  metadata?: Record<string, unknown>;
  previousResponseId?: string | null;
  body?: ResponsesRequest;
}) {
  const created = Math.floor(Date.now() / 1000);
  const response = buildResponseObject({
    id: opts.responseId,
    model: opts.model,
    createdAt: created,
    status: opts.status,
    output: buildOutputItems(opts.text, '', []),
    usage: null,
    body: opts.body || ({ model: opts.model } as ResponsesRequest),
    previousResponseId: opts.previousResponseId ?? null,
    sessionId: opts.chainSessionId,
    incompleteReason: opts.incompleteReason,
  });
  response.metadata = {
    ...(response.metadata || {}),
    manus_session_id: opts.manusSessionId,
    ...(opts.metadata || {}),
  };
  responseStore.put(
    responseStore.makeRecord(
      response,
      opts.messages,
      opts.manusSessionId,
      opts.lastEventId,
      opts.accountId
    )
  );
  return response;
}

function mapTurnToChatFields(result: ManusChatResult, cleanText: string, toolCalls: unknown[]) {
  const requires_action = result.status === 'requires_input';
  const cancelled = result.status === 'cancelled';
  const finish_reason = cancelled
    ? ('stop' as const)
    : toolCalls.length
      ? ('tool_calls' as const)
      : ('stop' as const);
  return {
    finish_reason,
    requires_action,
    requires_action_detail: requires_action
      ? {
          type: 'awaiting_user_input' as const,
          prompt: result.requiresInput?.prompt || cleanText,
          reason: result.requiresInput?.reason,
        }
      : undefined,
    cancelled,
  };
}

// ─── Chat Completions ────────────────────────────────────────

export async function runChatCompletionNonStream(
  body: OpenAIChatRequest,
  accountHint?: string | null
): Promise<OpenAIChatResponse> {
  const continuity = resolveContinuity(accountHint ?? body.account, {
    sessionId: body.session_id,
    manusSessionId: body.manus_session_id,
  });
  const auth = await ensureAuth(continuity.accountId);
  continuity.accountId = auth.accountId;

  const toolBundle = toolsPromptFor(body.tools);
  const { tools, prompt: toolsPrompt, hasHostTools } = toolBundle;
  const { prompt, images } = buildOutboundPrompt(body.messages, continuity, toolsPrompt);
  if (!prompt.trim() && images.length === 0) {
    throw new Error('messages produced an empty prompt');
  }

  const id = `chatcmpl-${uuidv4()}`;
  const ac = new AbortController();
  let stopManus: (() => void) | undefined;
  registerRun({
    id,
    kind: 'chat',
    accountId: continuity.accountId,
    manusSessionId: continuity.manusSessionId,
    abort: ac,
    startedAt: Date.now(),
    stopManus: () => stopManus?.(),
  });

  let result: ManusChatResult;
  try {
    result = await runWithToolLoop({
      prompt,
      model: body.model,
      accountId: continuity.accountId,
      sessionId: continuity.manusSessionId,
      lastEventId: continuity.lastEventId,
      images,
      tools,
      hasHostTools,
      signal: ac.signal,
      onReady: (ctl) => {
        stopManus = ctl.stop;
      },
    });
  } finally {
    unregisterRun(id);
  }

  assertCreditsOk(result);

  const { cleanText, toolCalls } = parseToolCallsFromText(result.content);
  const fields = mapTurnToChatFields(result, cleanText, toolCalls);
  const reasoning = result.reasoning || '';

  const thinkBridge = new ThinkingStreamBridge();
  // Seed bridge with full reasoning for non-stream wrap
  if (reasoning) {
    thinkBridge.thoughtChunks(
      { id: 'x', created: 0, model: body.model },
      reasoning
    );
  }

  let message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: MessageToolCall[];
  } = toolCalls.length
    ? { role: 'assistant', content: cleanText || null, tool_calls: toolCalls }
    : { role: 'assistant', content: cleanText };

  message = thinkBridge.applyToMessage(message);

  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: message.content,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };

  const chainMessages = [...continuity.priorMessages, ...body.messages, assistantMsg];
  const chainSessionId = continuity.clientSessionId || result.sessionId;
  const fakeRespId = makeResponseId();
  persistContinuity({
    responseId: fakeRespId,
    model: body.model,
    chainSessionId,
    manusSessionId: result.sessionId,
    lastEventId: result.lastEventId,
    accountId: continuity.accountId,
    messages: chainMessages,
    text: cleanText,
    status:
      result.status === 'requires_input'
        ? 'incomplete'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'completed',
    incompleteReason:
      result.status === 'requires_input' ? 'awaiting_user_input' : null,
    metadata: {
      source: 'chat.completions',
      requires_action: fields.requires_action,
      requires_action_detail: fields.requires_action_detail,
      reasoning: reasoning || undefined,
    },
  });

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: message.content,
          reasoning_content: message.reasoning_content ?? (reasoning || null),
          reasoning: message.reasoning ?? (reasoning || null),
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
        finish_reason: fields.finish_reason,
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil((cleanText || result.content).length / 4),
      total_tokens: Math.ceil(
        (prompt.length + (cleanText || result.content).length + reasoning.length) / 4
      ),
    },
    session_id: chainSessionId,
    requires_action: fields.requires_action,
    requires_action_detail: fields.requires_action_detail,
    cancelled: fields.cancelled,
  };
}

export async function runChatCompletionStream(
  body: OpenAIChatRequest,
  writer: SseWriter,
  accountHint?: string | null
): Promise<void> {
  const continuity = resolveContinuity(accountHint ?? body.account, {
    sessionId: body.session_id,
    manusSessionId: body.manus_session_id,
  });

  const id = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);
  let assembled = '';

  const ac = new AbortController();
  let stopManus: (() => void) | undefined;
  writer.onAbort(() => {
    stopManus?.();
    ac.abort('client_disconnect');
  });

  // FIRST BYTE — role only, NO content:"" (OpenCode closes reasoning on first content)
  await writer.write({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
        logprobs: null,
      },
    ],
  });

  // Auth + prompt build after stream is open (can be slow)
  const authS = await ensureAuth(continuity.accountId);
  continuity.accountId = authS.accountId;

  const toolBundle = toolsPromptFor(body.tools);
  const { tools, prompt: toolsPrompt, hasHostTools } = toolBundle;
  const { prompt, images } = buildOutboundPrompt(body.messages, continuity, toolsPrompt);
  if (!prompt.trim() && images.length === 0) {
    throw new Error('messages produced an empty prompt');
  }

  registerRun({
    id,
    kind: 'chat',
    accountId: continuity.accountId,
    manusSessionId: continuity.manusSessionId,
    abort: ac,
    startedAt: Date.now(),
    stopManus: () => stopManus?.(),
  });

  const thinkBridge = new ThinkingStreamBridge();
  let contentStarted = false;
  let toolHold = false; // buffer <tool_call> — never dump XML as content to OpenCode
  const baseChunk = { id, created, model: body.model };

  const writeContentSlice = async (slice: string) => {
    if (writer.aborted() || !slice) return;
    if (!contentStarted) {
      contentStarted = true;
      thinkBridge.markContentPhase();
      const close = thinkBridge.closeThinkTags(baseChunk);
      if (close) await writer.write(close);
    }
    assembled += slice;
    await writer.write({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: { content: slice },
          finish_reason: null,
          logprobs: null,
        },
      ],
    });
  };

  let result: ManusChatResult;
  try {
    result = await runWithToolLoop({
      prompt,
      model: body.model,
      accountId: continuity.accountId,
      sessionId: continuity.manusSessionId,
      lastEventId: continuity.lastEventId,
      images,
      tools,
      hasHostTools,
      signal: ac.signal,
      onReady: (ctl) => {
        stopManus = ctl.stop;
      },
      handlers: {
        onDelta: async (text) => {
          if (!text || writer.aborted()) return;
          // Never inject think tags into the answer body
          let piece = stripThinkTags(text);
          if (!piece) return;

          // Hold tool protocol text — OpenCode needs structured tool_calls, not XML dump
          const markers = ['<tool_call', '<tool_calls', '```tool_call'];
          if (
            toolHold ||
            markers.some((m) => piece.includes(m) || assembled.includes(m))
          ) {
            if (!toolHold) {
              let cut = -1;
              for (const m of markers) {
                const i = piece.indexOf(m);
                if (i >= 0 && (cut < 0 || i < cut)) cut = i;
              }
              if (cut > 0) {
                const prose = piece.slice(0, cut);
                await emitProgressive(prose, writeContentSlice, {
                  aborted: () => writer.aborted(),
                });
                piece = piece.slice(cut);
              }
              toolHold = true;
            }
            assembled += piece;
            return;
          }

          // Progressive micro-chunks so OpenCode typewriters instead of dumping a wall
          await emitProgressive(piece, writeContentSlice, {
            aborted: () => writer.aborted(),
          });
        },
        onThought: async (thought) => {
          if (!thought || writer.aborted()) return;
          await emitProgressive(
            thought,
            async (slice) => {
              if (writer.aborted() || !slice) return;
              const chunks = thinkBridge.thoughtChunks(baseChunk, slice);
              for (const ch of chunks) {
                await writer.write(ch);
              }
            },
            { maxChunk: 28, delayMs: 10, aborted: () => writer.aborted() }
          );
        },
        onAgentEvent: async (ev) => {
          if (writer.aborted()) return;
          // Comments only — empty JSON deltas confuse strict OpenAI-compatible parsers
          await writer.writeComment(
            `manus-agent ${ev.type}${ev.brief ? ' ' + ev.brief.slice(0, 80) : ''}`
          );
        },
        onRequiresInput: async (info) => {
          if (writer.aborted()) return;
          await writer.write({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: null,
                logprobs: null,
              },
            ],
            requires_action: true,
            requires_action_detail: {
              type: 'awaiting_user_input',
              prompt: info.prompt,
              reason: info.reason,
            },
          } as any);
        },
      },
    });
  } catch (err) {
    unregisterRun(id);
    if (isAbortError(err) || writer.aborted()) {
      await writer.write({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        cancelled: true,
      } as any);
      await writer.writeDone();
      return;
    }
    throw err;
  } finally {
    unregisterRun(id);
  }

  // Credits gone mid-stream: emit clean error instead of more nudges
  if (result.creditsExhausted || result.status === 'credits_exhausted') {
    const msg =
      stripHostNudgeFrom(result.content) ||
      'Créditos da Manus esgotados. Espere o refresh diário ou troque de conta.';
    await writer.writeError(msg, 'insufficient_quota', 'insufficient_quota');
    await writer.writeDone();
    return;
  }

  // If thinking only arrived in the final result (no live deltas), flush once
  if (result.reasoning && !thinkBridge.hasReasoning && !contentStarted) {
    for (const ch of thinkBridge.thoughtChunks(baseChunk, result.reasoning)) {
      await writer.write(ch);
    }
  } else if (result.reasoning && thinkBridge.reasoning.length < result.reasoning.length) {
    const net = result.reasoning.slice(thinkBridge.reasoning.length);
    if (net) {
      for (const ch of thinkBridge.thoughtChunks(baseChunk, net)) {
        await writer.write(ch);
      }
    }
  }

  if (!contentStarted) {
    const close = thinkBridge.closeThinkTags(baseChunk);
    if (close) await writer.write(close);
  }

  // Prefer full Manus content for tool_call parsing (assembled may miss XML)
  const finalText = stripThinkTags(result.content || assembled);
  const { cleanText, toolCalls } = parseToolCallsFromText(finalText);
  const fields = mapTurnToChatFields(result, cleanText, toolCalls);
  const reasoning = thinkBridge.reasoning || result.reasoning || '';

  if (result.status === 'cancelled' || writer.aborted()) {
    await writer.write({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      cancelled: true,
      session_id: continuity.clientSessionId || result.sessionId,
    } as any);
    await writer.writeDone();
    return;
  }

  if (toolCalls.length) {
    const deltas = toolCallsToSseDeltas(toolCalls);
    for (const d of deltas) {
      await writer.write({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: d.index,
                  id: d.id,
                  type: 'function',
                  function: { name: d.function.name, arguments: d.function.arguments },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
    await writer.write({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    await writer.write({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      requires_action: fields.requires_action,
      requires_action_detail: fields.requires_action_detail,
      session_id: continuity.clientSessionId || result.sessionId,
    } as any);
  }

  const assistantMsg: ChatMessage = toolCalls.length
    ? { role: 'assistant', content: cleanText || null, tool_calls: toolCalls }
    : { role: 'assistant', content: cleanText || finalText };
  const chainSessionId = continuity.clientSessionId || result.sessionId;
  persistContinuity({
    responseId: makeResponseId(),
    model: body.model,
    chainSessionId,
    manusSessionId: result.sessionId,
    lastEventId: result.lastEventId,
    accountId: continuity.accountId,
    messages: [...continuity.priorMessages, ...body.messages, assistantMsg],
    text: cleanText || finalText,
    status: result.status === 'requires_input' ? 'incomplete' : 'completed',
    incompleteReason:
      result.status === 'requires_input' ? 'awaiting_user_input' : null,
    metadata: {
      source: 'chat.completions.stream',
      requires_action: fields.requires_action,
      reasoning: reasoning || undefined,
    },
  });

  await writer.writeDone();
}

// ─── Responses API ───────────────────────────────────────────

export async function runResponsesNonStream(
  body: ResponsesRequest,
  accountHint?: string | null
): Promise<ResponseObject> {
  const previousId = resolvePreviousId(body);
  const continuity = resolveContinuity(accountHint ?? body.account, {
    previousResponseId: previousId,
    sessionId: body.session_id,
  });
  const authR = await ensureAuth(continuity.accountId);
  continuity.accountId = authR.accountId;

  // When reusing: only map *new* input, not full prior dump into prompt
  const newMessages = responsesInputToMessages(body, continuity.reuseSession ? [] : continuity.priorMessages);
  const toolBundle = toolsPromptFor(normalizeResponsesTools(body.tools));
  const { tools, prompt: toolsPrompt, hasHostTools } = toolBundle;

  const continuityForPrompt: Continuity = continuity.reuseSession
    ? continuity
    : { ...continuity, reuseSession: false };

  // If reusing session, treat newMessages as the "messages" for latest-turn extraction
  const messagesForPrompt = continuity.reuseSession
    ? newMessages
    : [...continuity.priorMessages, ...newMessages];

  const { prompt, images } = buildOutboundPrompt(
    messagesForPrompt,
    continuityForPrompt,
    toolsPrompt
  );

  if (!prompt.trim() && images.length === 0) {
    throw new Error('input produced an empty prompt');
  }

  const responseId = makeResponseId();
  const ac = new AbortController();
  let stopManus: (() => void) | undefined;
  registerRun({
    id: responseId,
    kind: 'response',
    accountId: continuity.accountId,
    manusSessionId: continuity.manusSessionId,
    abort: ac,
    startedAt: Date.now(),
    stopManus: () => stopManus?.(),
  });

  let result: ManusChatResult;
  try {
    result = await runWithToolLoop({
      prompt,
      model: body.model,
      accountId: continuity.accountId,
      sessionId: continuity.manusSessionId,
      lastEventId: continuity.lastEventId,
      images,
      tools,
      hasHostTools,
      signal: ac.signal,
      onReady: (ctl) => {
        stopManus = ctl.stop;
      },
    });
  } finally {
    unregisterRun(responseId);
  }

  const { cleanText, toolCalls } = parseToolCallsFromText(result.content);
  const reasoning = result.reasoning || '';
  const usage = mapChatUsage({
    prompt_tokens: Math.ceil(prompt.length / 4),
    completion_tokens: Math.ceil((cleanText || result.content).length / 4),
    total_tokens: Math.ceil(
      (prompt.length + (cleanText || result.content).length + reasoning.length) / 4
    ),
  });
  if (reasoning) {
    usage.output_tokens_details.reasoning_tokens = Math.ceil(reasoning.length / 4);
  }

  const clientSessionId = continuity.clientSessionId || body.session_id || result.sessionId;
  const status: ResponseObject['status'] =
    result.status === 'requires_input'
      ? 'incomplete'
      : result.status === 'cancelled'
        ? 'cancelled'
        : 'completed';
  const output = buildOutputItems(cleanText, reasoning, toolCalls);
  const response = buildResponseObject({
    id: responseId,
    model: body.model,
    createdAt: Math.floor(Date.now() / 1000),
    status,
    output,
    usage,
    body,
    previousResponseId: previousId,
    sessionId: clientSessionId,
    incompleteReason:
      result.status === 'requires_input' ? 'awaiting_user_input' : null,
  });
  response.metadata = {
    ...(response.metadata || {}),
    manus_session_id: result.sessionId,
    reasoning: reasoning || undefined,
    requires_action: result.status === 'requires_input',
    requires_action_detail:
      result.status === 'requires_input'
        ? {
            type: 'awaiting_user_input',
            prompt: result.requiresInput?.prompt || cleanText,
            reason: result.requiresInput?.reason,
          }
        : undefined,
  };

  if (body.store !== false) {
    const assistantMsg: ChatMessage = toolCalls.length
      ? { role: 'assistant', content: cleanText || null, tool_calls: toolCalls }
      : { role: 'assistant', content: cleanText };
    responseStore.put(
      responseStore.makeRecord(
        response,
        [...continuity.priorMessages, ...newMessages, assistantMsg],
        result.sessionId,
        result.lastEventId,
        continuity.accountId
      )
    );
  }

  return response;
}

export async function runResponsesStream(
  body: ResponsesRequest,
  writer: SseWriter,
  accountHint?: string | null
): Promise<void> {
  const previousId = resolvePreviousId(body);
  const continuity = resolveContinuity(accountHint ?? body.account, {
    previousResponseId: previousId,
    sessionId: body.session_id,
  });
  const authRS = await ensureAuth(continuity.accountId);
  continuity.accountId = authRS.accountId;

  const newMessages = responsesInputToMessages(body, continuity.reuseSession ? [] : continuity.priorMessages);
  const toolBundle = toolsPromptFor(normalizeResponsesTools(body.tools));
  const { tools, prompt: toolsPrompt, hasHostTools } = toolBundle;
  const messagesForPrompt = continuity.reuseSession
    ? newMessages
    : [...continuity.priorMessages, ...newMessages];

  const { prompt, images } = buildOutboundPrompt(
    messagesForPrompt,
    continuity.reuseSession ? continuity : { ...continuity, reuseSession: false },
    toolsPrompt
  );

  if (!prompt.trim() && images.length === 0) {
    throw new Error('input produced an empty prompt');
  }

  const responseId = makeResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const clientSessionId = continuity.clientSessionId || body.session_id || null;

  const emitter = new ResponsesStreamEmitter(
    responseId,
    body.model,
    createdAt,
    body,
    previousId,
    clientSessionId,
    async (event, payload) => {
      await writer.writeEvent(event, payload);
    }
  );

  await emitter.emitCreated();

  const ac = new AbortController();
  let stopManus: (() => void) | undefined;
  writer.onAbort(() => {
    stopManus?.();
    ac.abort('client_disconnect');
  });
  registerRun({
    id: responseId,
    kind: 'response',
    accountId: continuity.accountId,
    manusSessionId: continuity.manusSessionId,
    abort: ac,
    startedAt: Date.now(),
    stopManus: () => stopManus?.(),
  });

  let assembled = '';
  let result: ManusChatResult;
  try {
    result = await runWithToolLoop({
      prompt,
      model: body.model,
      accountId: continuity.accountId,
      sessionId: continuity.manusSessionId,
      lastEventId: continuity.lastEventId,
      images,
      tools,
      hasHostTools,
      signal: ac.signal,
      onReady: (ctl) => {
        stopManus = ctl.stop;
      },
      handlers: {
        onDelta: async (text) => {
          if (!text || writer.aborted()) return;
          if (text.includes('<tool_call') || assembled.includes('<tool_call')) {
            assembled += text;
            return;
          }
          await emitProgressive(
            text,
            async (slice) => {
              if (writer.aborted() || !slice) return;
              assembled += slice;
              await emitter.emitTextDelta(slice);
            },
            { aborted: () => writer.aborted() }
          );
        },
        onThought: async (thought) => {
          if (!thought || writer.aborted()) return;
          await emitProgressive(
            thought,
            async (slice) => {
              if (writer.aborted() || !slice) return;
              await emitter.emitReasoningDelta(slice);
            },
            { maxChunk: 28, delayMs: 10, aborted: () => writer.aborted() }
          );
        },
        onRequiresInput: async (info) => {
          if (writer.aborted()) return;
          await writer.writeEvent('manus.requires_input', {
            type: 'manus.requires_input',
            response_id: responseId,
            session_id: clientSessionId,
            prompt: info.prompt,
            reason: info.reason,
            agent_status: info.agentStatus,
            session_status: info.sessionStatus,
          });
        },
      },
    });
  } catch (err) {
    unregisterRun(responseId);
    if (isAbortError(err) || writer.aborted()) {
      await writer.writeEvent('response.cancelled', {
        type: 'response.cancelled',
        response_id: responseId,
        reason: 'client_cancel',
      });
      return;
    }
    throw err;
  } finally {
    unregisterRun(responseId);
  }

  if (result.creditsExhausted || result.status === 'credits_exhausted') {
    await writer.writeError(
      stripHostNudgeFrom(result.content) ||
        'Créditos da Manus esgotados. Espere o refresh diário ou troque de conta.',
      'insufficient_quota',
      'insufficient_quota'
    );
    return;
  }

  if (result.status === 'cancelled' || writer.aborted()) {
    await writer.writeEvent('response.cancelled', {
      type: 'response.cancelled',
      response_id: responseId,
      reason: 'client_cancel',
      session_id: clientSessionId || result.sessionId,
      metadata: { manus_session_id: result.sessionId },
    });
    // still store partial for continuity
    if (body.store !== false && (assembled || result.content)) {
      persistContinuity({
        responseId,
        model: body.model,
        chainSessionId: clientSessionId || result.sessionId,
        manusSessionId: result.sessionId,
        lastEventId: result.lastEventId,
        accountId: continuity.accountId,
        messages: [
          ...continuity.priorMessages,
          ...newMessages,
          { role: 'assistant', content: assembled || result.content },
        ],
        text: assembled || result.content,
        status: 'cancelled',
        body,
        previousResponseId: previousId,
        metadata: { source: 'responses.stream', cancelled: true },
      });
    }
    return;
  }

  const finalText = assembled || result.content;
  const { cleanText, toolCalls } = parseToolCallsFromText(finalText);

  if (finalText.includes('<tool_call') || finalText.includes('<tool_calls')) {
    if (cleanText && !emitter.getText()) {
      await emitter.emitTextDelta(cleanText);
    }
  } else if (cleanText && emitter.getText().length < cleanText.length) {
    const net = cleanText.slice(emitter.getText().length);
    if (net) await emitter.emitTextDelta(net);
  }

  if (toolCalls.length) {
    await emitter.emitToolCalls(toolCalls);
  }

  const usage = mapChatUsage({
    prompt_tokens: Math.ceil(prompt.length / 4),
    completion_tokens: Math.ceil((cleanText || finalText).length / 4),
    total_tokens: Math.ceil((prompt.length + (cleanText || finalText).length) / 4),
  });

  // If thinking arrived only at the end (no deltas), flush once
  const reasoning = result.reasoning || emitter.getReasoning();
  if (reasoning && !emitter.getReasoning()) {
    await emitter.emitReasoningDelta(reasoning);
  } else if (reasoning && emitter.getReasoning().length < reasoning.length) {
    const net = reasoning.slice(emitter.getReasoning().length);
    if (net) await emitter.emitReasoningDelta(net);
  }

  const response = await emitter.emitCompleted(usage, toolCalls);
  response.session_id = clientSessionId || result.sessionId;

  if (result.status === 'requires_input') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: 'awaiting_user_input' };
    response.completed_at = null;
    await writer.writeEvent('response.incomplete', {
      type: 'response.incomplete',
      response,
    });
  }

  response.metadata = {
    ...(response.metadata || {}),
    manus_session_id: result.sessionId,
    reasoning: reasoning || undefined,
    requires_action: result.status === 'requires_input',
    requires_action_detail:
      result.status === 'requires_input'
        ? {
            type: 'awaiting_user_input',
            prompt: result.requiresInput?.prompt || cleanText,
            reason: result.requiresInput?.reason,
          }
        : undefined,
  };

  if (body.store !== false) {
    const assistantMsg: ChatMessage = toolCalls.length
      ? { role: 'assistant', content: cleanText || null, tool_calls: toolCalls }
      : { role: 'assistant', content: cleanText || finalText };
    responseStore.put(
      responseStore.makeRecord(
        response,
        [...continuity.priorMessages, ...newMessages, assistantMsg],
        result.sessionId,
        result.lastEventId,
        continuity.accountId
      )
    );
  }
}
