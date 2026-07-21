import { io, type Socket } from 'socket.io-client';
import { customAlphabet } from 'nanoid';
import { getManusAuth } from '../services/playwright.ts';
import type { OpenAITool } from '../openai/types.ts';
import { withAutonomy } from './autonomy.ts';

const shortUID = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  22
);

export type ManusTaskMode = 'standard' | 'chat' | 'adaptive' | 'lite' | string;

export type ManusTurnStatus =
  | 'completed'
  | 'requires_input'
  | 'cancelled'
  | 'error';

export type ManusContentPart =
  | { type: 'text'; value: string }
  | { type: 'image'; value: string; mimeType?: string }
  | { type: 'image_url'; value: string }
  | { type: string; value: string; mimeType?: string };

export type ManusRequiresInput = {
  prompt: string;
  reason: string;
  agentStatus?: string;
  sessionStatus?: string;
  eventType?: string;
};

export type ManusChatResult = {
  sessionId: string;
  messageId: string;
  content: string;
  /** Accumulated Manus thinking / reasoning text */
  reasoning: string;
  lastEventId: string | null;
  events: unknown[];
  status: ManusTurnStatus;
  requiresInput?: ManusRequiresInput;
};

/** Agent desktop / sandbox / tool activity (safe extras for SSE) */
export type ManusAgentEvent = {
  type: string;
  brief?: string;
  status?: string;
  tool?: string;
  sandboxId?: string;
  vncUrl?: string;
  agentStatus?: string;
  raw?: unknown;
};

export type ManusChatStreamHandlers = {
  onDelta?: (text: string) => void | Promise<void>;
  onEvent?: (event: unknown) => void | Promise<void>;
  /** Net-new thinking delta only (already de-duplicated) */
  onThought?: (text: string) => void | Promise<void>;
  /** Fired when Manus pauses waiting for the human */
  onRequiresInput?: (info: ManusRequiresInput) => void | Promise<void>;
  onStatus?: (status: string, detail?: unknown) => void | Promise<void>;
  /**
   * Agent-mode activity (sandbox PC, tools, live status).
   * Emitted sparingly so SSE clients don't choke.
   */
  onAgentEvent?: (ev: ManusAgentEvent) => void | Promise<void>;
};

const AGENT_EVENT_TYPES = new Set([
  'sandboxUpdate',
  'toolUsed',
  'toolUse',
  'liveStatus',
  'statusUpdate',
  'queueStatusChange',
  'desktopUpdate',
  'browserAction',
]);

function toAgentEvent(ev: Record<string, unknown>): ManusAgentEvent | null {
  const type = String(ev.type || '');
  if (!AGENT_EVENT_TYPES.has(type)) return null;

  // Skip ultra-noisy short live labels unless useful
  if (type === 'liveStatus') {
    const text = String(ev.text || ev.brief || '');
    if (text.length < 3) return null;
  }

  return {
    type,
    brief: String(ev.brief || ev.text || ev.description || '').slice(0, 240) || undefined,
    status: ev.status != null ? String(ev.status) : undefined,
    tool: ev.tool != null ? String(ev.tool) : undefined,
    sandboxId: ev.sandboxId != null ? String(ev.sandboxId) : undefined,
    vncUrl: ev.vncUrl != null ? String(ev.vncUrl) : undefined,
    agentStatus: ev.agentStatus != null ? String(ev.agentStatus) : undefined,
    // don't dump full raw — keep SSE small
  };
}

function jwtFromAuth(authorization: string): string {
  const t = authorization.trim();
  if (t.toLowerCase().startsWith('bearer ')) return t.slice(7).trim();
  return t;
}

export function resolveTaskMode(modelId: string): ManusTaskMode {
  const id = modelId.toLowerCase();
  if (id.includes('chat')) return 'chat';
  if (id.includes('adaptive')) return 'adaptive';
  if (id.includes('lite') || id.includes('fast')) return 'lite';
  if (id.includes('agent')) return 'standard';
  return 'standard';
}

/**
 * When the host client (OpenCode/Codex) sends tools, Manus *agent* mode will
 * happily write files under /home/ubuntu on its cloud VM and never emit host
 * tool_calls. Force chat-like modes so the model answers with <tool_call> text
 * that we parse into OpenAI tool_calls for the client.
 *
 * Override with MANUS_FORCE_CHAT_WITH_TOOLS=false to keep agent mode.
 */
export function resolveTaskModeForTools(
  modelId: string,
  hasHostTools: boolean
): ManusTaskMode {
  const base = resolveTaskMode(modelId);
  if (!hasHostTools) return base;
  const force =
    process.env.MANUS_FORCE_CHAT_WITH_TOOLS !== '0' &&
    process.env.MANUS_FORCE_CHAT_WITH_TOOLS !== 'false';
  if (!force) return base;
  if (base === 'chat' || base === 'lite') return base;
  // adaptive keeps some planning but still text-first; prefer chat for tools
  return 'chat';
}

function extractAssistantText(event: Record<string, unknown>): string {
  if (event.type === 'chatDelta') {
    const delta = event.delta as { content?: string; thought?: string } | undefined;
    return delta?.content || '';
  }
  if (event.type === 'chat' && event.sender === 'assistant') {
    return String(event.content || '');
  }
  return '';
}

/**
 * Extract Manus thinking text from various event shapes.
 * Returns the thought payload as received (may be cumulative or incremental).
 */
function pickThoughtFields(obj: Record<string, unknown> | undefined | null): string {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of [
    'thought',
    'reasoning',
    'thinking',
    'reasoningContent',
    'reasoning_content',
    'chainOfThought',
    'chain_of_thought',
    'innerMonologue',
    'plan',
  ]) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function extractThought(event: Record<string, unknown>): string {
  if (event.type === 'chatDelta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    const fromDelta = pickThoughtFields(delta);
    if (fromDelta) return fromDelta;
    // nested: delta.message / delta.payload
    if (delta?.message && typeof delta.message === 'object') {
      const m = pickThoughtFields(delta.message as Record<string, unknown>);
      if (m) return m;
    }
  }

  if (event.type === 'chat' && event.sender === 'assistant') {
    const t = pickThoughtFields(event);
    if (t) return t;
    const delta = event.delta as Record<string, unknown> | undefined;
    const fromDelta = pickThoughtFields(delta);
    if (fromDelta) return fromDelta;
  }

  // Manus sometimes streams plan / think as separate event types
  if (
    event.type === 'thought' ||
    event.type === 'thinking' ||
    event.type === 'reasoning' ||
    event.type === 'chatThought' ||
    event.type === 'plan' ||
    event.type === 'agentThought' ||
    event.type === 'internalThought'
  ) {
    return (
      pickThoughtFields(event) ||
      String(event.content || event.text || '') ||
      pickThoughtFields(event.delta as Record<string, unknown> | undefined)
    );
  }

  // liveStatus / statusUpdate with long text is sometimes the "thinking out loud" channel
  if (event.type === 'liveStatus' || event.type === 'statusUpdate') {
    const text = String(
      event.text || event.brief || event.description || event.message || ''
    );
    // skip short UI labels like "Pensando" / "Working"
    if (text.length >= 40) return text;
  }

  // Some agent builds put plan text under payload / data
  if (event.payload && typeof event.payload === 'object') {
    const p = pickThoughtFields(event.payload as Record<string, unknown>);
    if (p) return p;
  }
  if (event.data && typeof event.data === 'object') {
    const d = pickThoughtFields(event.data as Record<string, unknown>);
    if (d) return d;
  }

  return '';
}

/** Merge thought fragments (cumulative or append) → net-new slice only */
function mergeThoughtDelta(prev: string, incoming: string): { full: string; net: string } {
  if (!incoming) return { full: prev, net: '' };
  if (!prev) return { full: incoming, net: incoming };
  if (incoming.startsWith(prev)) {
    const net = incoming.slice(prev.length);
    return { full: incoming, net };
  }
  if (prev.endsWith(incoming) || prev.includes(incoming)) {
    return { full: prev, net: '' };
  }
  // append
  return { full: prev + incoming, net: incoming };
}

/** Detect HITL / waiting-for-human states from Manus events */
export function detectRequiresInput(
  ev: Record<string, unknown>,
  notification?: Record<string, unknown>
): ManusRequiresInput | null {
  const waitAgent = [
    'waiting',
    'paused',
    'pending',
    'waiting_for_user',
    'wait_for_user',
    'need_user',
    'need_user_input',
    'awaiting_user',
    'awaiting_input',
    'confirm',
    'user_confirm',
    'idle_waiting',
  ];
  const waitSession = [
    'SESSION_STATUS_WAITING',
    'SESSION_STATUS_PENDING',
    'SESSION_STATUS_WAITING_FOR_USER',
    'SESSION_STATUS_PAUSED',
    'SESSION_STATUS_NEED_USER_INPUT',
    'SESSION_STATUS_AWAITING_USER',
    'SESSION_STATUS_INTERACTION',
  ];
  const waitEventTypes = [
    'askUser',
    'ask_user',
    'userConfirm',
    'user_confirm',
    'confirmationRequest',
    'requireUserInput',
    'require_user_input',
    'pendingUserInput',
    'interactionRequired',
    'waitForUser',
    'humanInputRequired',
  ];

  const agentStatus = String(ev.agentStatus || ev.status || '').toLowerCase();
  const eventType = String(ev.type || '');
  const brief = String(ev.brief || ev.description || ev.text || ev.prompt || '');

  if (waitEventTypes.some((t) => eventType.toLowerCase() === t.toLowerCase())) {
    return {
      prompt: brief || 'Manus está aguardando sua resposta para continuar.',
      reason: 'event_' + eventType,
      agentStatus: agentStatus || undefined,
      eventType,
    };
  }

  if (ev.type === 'statusUpdate' || ev.type === 'queueStatusChange') {
    if (waitAgent.some((w) => agentStatus.includes(w))) {
      return {
        prompt: brief || 'Manus pausou e espera sua resposta.',
        reason: 'agent_status_' + agentStatus,
        agentStatus,
        eventType,
      };
    }
  }

  // Explicit interaction payloads
  if (ev.needUserInput || ev.requiresUserInput || ev.waitForUser) {
    return {
      prompt: brief || 'Entrada do usuário necessária.',
      reason: 'flag_need_user_input',
      agentStatus: agentStatus || undefined,
      eventType,
    };
  }

  if (notification) {
    const data = (notification.data || notification) as Record<string, unknown>;
    const st = String(data.status || '');
    if (waitSession.some((s) => st === s || st.includes('WAITING') || st.includes('PENDING'))) {
      if (st.includes('STOPPED') || st.includes('RUNNING')) {
        // not waiting
      } else if (
        st.includes('WAITING') ||
        st.includes('PENDING') ||
        st.includes('PAUSED') ||
        st.includes('INTERACTION')
      ) {
        return {
          prompt: String(data.lastDisplayMessage || brief || 'Aguardando você continuar.'),
          reason: 'session_' + st,
          sessionStatus: st,
        };
      }
    }
  }

  // Heuristic: assistant asked a question and agent is no longer running
  if (
    ev.type === 'chat' &&
    ev.sender === 'assistant' &&
    typeof ev.content === 'string' &&
    /\?\s*$/.test(ev.content.trim()) &&
    agentStatus &&
    !['running', 'thinking', 'working'].includes(agentStatus)
  ) {
    // soft signal — only if combined with non-running later
  }

  return null;
}

function buildContents(
  text: string,
  images?: Array<{ dataUrl: string; mime: string }>
): ManusContentPart[] {
  const contents: ManusContentPart[] = [];
  if (text?.trim()) {
    contents.push({ type: 'text', value: text });
  }
  for (const img of images || []) {
    if (img.dataUrl.startsWith('data:image')) {
      contents.push({
        type: 'image',
        value: img.dataUrl,
        mimeType: img.mime || 'image/png',
      });
    } else if (img.dataUrl) {
      contents.push({ type: 'image_url', value: img.dataUrl });
    }
  }
  if (contents.length === 0) {
    contents.push({ type: 'text', value: text || '' });
  }
  return contents;
}

/** Best-effort stop signals Manus understands (try a few shapes). */
export function buildStopPayloads(sessionId: string): Record<string, unknown>[] {
  const base = {
    id: shortUID(),
    timestamp: Date.now(),
    sessionId,
  };
  return [
    { ...base, type: 'stop_session' },
    { ...base, id: shortUID(), type: 'user_stop' },
    { ...base, id: shortUID(), type: 'stop' },
    { ...base, id: shortUID(), type: 'cancel_task' },
  ];
}

export async function sendManusChat(opts: {
  prompt: string;
  model?: string;
  accountId?: string | null;
  sessionId?: string | null;
  lastEventId?: string | null;
  images?: Array<{ dataUrl: string; mime: string }>;
  tools?: OpenAITool[];
  toolPromptSuffix?: string;
  /** Host has OpenAI tools (client and/or builtins) — forces chat mode by default */
  hasHostTools?: boolean;
  /** Override Manus taskMode (chat | standard | adaptive | lite) */
  taskMode?: ManusTaskMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  handlers?: ManusChatStreamHandlers;
  /** Expose stop fn for active-runs registry */
  onReady?: (ctl: { stop: () => void; sessionId: string }) => void;
}): Promise<ManusChatResult> {
  const auth = await getManusAuth(opts.accountId);
  if (!auth.authorization) {
    throw new Error('Sem Authorization JWT — rode npm run login -- --account=<id>');
  }
  const token = jwtFromAuth(auth.authorization);
  const taskMode =
    opts.taskMode ??
    resolveTaskModeForTools(opts.model || 'manus', Boolean(opts.hasHostTools));
  const isContinue = Boolean(opts.sessionId);
  const sessionId = opts.sessionId || shortUID();
  const messageId = shortUID();
  const timeoutMs = opts.timeoutMs ?? 300_000; // agents can wait longer
  const isChatMode = taskMode === 'chat' || taskMode === 'lite';

  const tz =
    auth.extras['x-client-timezone'] ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'America/Sao_Paulo';
  const locale = auth.extras['x-client-locale'] || 'pt-BR';

  // Safety net: autonomy is applied again here so every code path is covered
  const fullPrompt = withAutonomy(
    opts.toolPromptSuffix
      ? `${opts.prompt}\n\n${opts.toolPromptSuffix}`
      : opts.prompt
  );

  return new Promise<ManusChatResult>((resolve, reject) => {
    let settled = false;
    let content = '';
    let reasoning = '';
    let lastEventId: string | null = opts.lastEventId || null;
    let sawAssistantChat = false;
    let agentRunning = false;
    let turnStatus: ManusTurnStatus = 'completed';
    let requiresInput: ManusRequiresInput | undefined;
    let stopGrace: ReturnType<typeof setTimeout> | null = null;
    const events: unknown[] = [];
    let socket: Socket | null = null;

    const finish = (err?: Error, status?: ManusTurnStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopGrace) clearTimeout(stopGrace);
      opts.signal?.removeEventListener('abort', onAbort);
      if (status) turnStatus = status;
      try {
        socket?.disconnect();
      } catch {
        /* ignore */
      }
      if (err) {
        if (/abort/i.test(err.message)) {
          resolve({
            sessionId,
            messageId,
            content: content.trim(),
            reasoning: reasoning.trim(),
            lastEventId,
            events,
            status: 'cancelled',
          });
          return;
        }
        reject(err);
      } else {
        resolve({
          sessionId,
          messageId,
          content: content.trim(),
          reasoning: reasoning.trim(),
          lastEventId,
          events,
          status: turnStatus,
          requiresInput,
        });
      }
    };

    const scheduleFinish = (ms = 450, status?: ManusTurnStatus) => {
      if (stopGrace) clearTimeout(stopGrace);
      stopGrace = setTimeout(() => finish(undefined, status), ms);
    };

    const sendStop = () => {
      if (!socket?.connected) return;
      for (const p of buildStopPayloads(sessionId)) {
        try {
          socket.emit('message', p);
        } catch {
          /* ignore */
        }
      }
      console.log(`[manus-ws] stop/cancel emitted session=${sessionId}`);
    };

    const onAbort = () => {
      sendStop();
      finish(new Error('Aborted'), 'cancelled');
    };
    opts.signal?.addEventListener('abort', onAbort);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    const timer = setTimeout(() => {
      if (requiresInput) finish(undefined, 'requires_input');
      else if (content) finish(undefined, 'completed');
      else finish(new Error(`Timeout after ${timeoutMs}ms waiting Manus reply`));
    }, timeoutMs);

    socket = io('wss://api.manus.im', {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token },
      query: {
        locale,
        tz,
        clientType: 'web',
        branch: '',
      },
      reconnection: false,
      timeout: 20_000,
      forceNew: true,
    });

    opts.onReady?.({
      stop: sendStop,
      sessionId,
    });

    socket.on('connect_error', (err) => {
      finish(new Error(`WS connect_error: ${err.message}`));
    });

    socket.on('connect', () => {
      if (isContinue) {
        const joinPayload = {
          id: shortUID(),
          timestamp: Date.now(),
          sessionId,
          lastMessageId: opts.lastEventId || undefined,
          type: 'join_session',
          version: 2,
        };
        console.log(`[manus-ws] join_session session=${sessionId}`);
        socket!.emit('message', joinPayload);
      }

      const contents = buildContents(fullPrompt, opts.images);
      const hasImage = contents.some((c) => c.type === 'image' || c.type === 'image_url');

      const payload: Record<string, unknown> = {
        id: messageId,
        timestamp: Date.now(),
        messageStatus: 'pending',
        type: 'user_message',
        sessionId,
        content: '',
        contents,
        messageType: hasImage ? 'mixed' : 'text',
        taskMode,
        attachments: [] as unknown[],
        extData: {} as Record<string, unknown>,
      };

      if (opts.images?.length) {
        payload.attachments = opts.images.map((img, i) => ({
          type: 'image',
          name: `image_${i}`,
          mimeType: img.mime,
          dataUrl: img.dataUrl.startsWith('data:') ? img.dataUrl : undefined,
          url: img.dataUrl.startsWith('data:') ? undefined : img.dataUrl,
        }));
      }

      console.log(
        `[manus-ws] emit user_message session=${sessionId} mode=${taskMode} continue=${isContinue} images=${opts.images?.length || 0}`
      );
      socket!.emit('message', payload);
    });

    const handleRequiresInput = async (info: ManusRequiresInput) => {
      requiresInput = info;
      turnStatus = 'requires_input';
      await opts.handlers?.onRequiresInput?.(info);
      // Keep session open a brief moment then complete turn as requires_input
      // (client continues via previous_response_id / session_id)
      scheduleFinish(200, 'requires_input');
    };

    const handleEvent = async (ev: Record<string, unknown>) => {
      if (ev.id) lastEventId = String(ev.id);
      await opts.handlers?.onEvent?.(ev);

      const thoughtRaw = extractThought(ev);
      if (thoughtRaw) {
        const { full, net } = mergeThoughtDelta(reasoning, thoughtRaw);
        reasoning = full;
        if (net) await opts.handlers?.onThought?.(net);
      }

      // Agent desktop / sandbox / tools (optional SSE side-channel)
      const agentEv = toAgentEvent(ev);
      if (agentEv) {
        await opts.handlers?.onAgentEvent?.(agentEv);
      }

      if (ev.type === 'statusUpdate') {
        const st = String(ev.agentStatus || '');
        await opts.handlers?.onStatus?.(st, ev);
        if (st === 'running' || st === 'thinking') agentRunning = true;
        if (st === 'stopped') agentRunning = false;
      }

      // HITL
      const need = detectRequiresInput(ev);
      if (need) {
        if (!content && need.prompt) {
          // surface the wait prompt as content if we have no assistant text yet
          content = need.prompt;
          await opts.handlers?.onDelta?.(need.prompt);
        }
        await handleRequiresInput(need);
        return;
      }

      if (ev.type === 'chatDelta') {
        const piece = extractAssistantText(ev);
        if (piece) {
          if (content && piece.startsWith(content)) {
            const net = piece.slice(content.length);
            content = piece;
            if (net) await opts.handlers?.onDelta?.(net);
          } else if (!content.endsWith(piece)) {
            content += piece;
            await opts.handlers?.onDelta?.(piece);
          }
        }
      }

      if (ev.type === 'chat' && ev.sender === 'assistant') {
        const full = String(ev.content || '');
        if (full) {
          if (!content || full.length >= content.length) {
            const prev = content;
            content = full;
            if (full.startsWith(prev)) {
              const net = full.slice(prev.length);
              if (net) await opts.handlers?.onDelta?.(net);
            } else if (!prev) {
              await opts.handlers?.onDelta?.(full);
            }
          }
          sawAssistantChat = true;
        }

        // Chat/lite: one-shot answer → finish
        // Agent modes: keep listening until stopped / requires_input
        if (isChatMode && full) {
          scheduleFinish(500, 'completed');
        }
      }

      if (ev.type === 'statusUpdate' && ev.agentStatus === 'stopped') {
        if (sawAssistantChat || content) scheduleFinish(350, 'completed');
        else if (!agentRunning) scheduleFinish(800, 'completed');
      }
    };

    socket.on('message', (raw: unknown) => {
      void (async () => {
        try {
          events.push(raw);
          await opts.handlers?.onEvent?.(raw);
          const msg = raw as Record<string, unknown>;
          if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
            await handleEvent(msg.event as Record<string, unknown>);
          } else if (msg.type && (msg as { sender?: string }).sender) {
            await handleEvent(msg);
          }
        } catch (e) {
          console.warn('[manus-ws] message handler error', e);
        }
      })();
    });

    socket.on('notification', (raw: unknown) => {
      void (async () => {
        try {
          events.push({ notification: raw });
          const n = raw as Record<string, unknown>;
          const data = n.data as {
            status?: string;
            lastDisplayMessage?: string;
            sessionUid?: string;
          } | undefined;

          const need = detectRequiresInput({}, n);
          if (need) {
            if (!content && data?.lastDisplayMessage) content = data.lastDisplayMessage;
            await handleRequiresInput(need);
            return;
          }

          if (data?.status === 'SESSION_STATUS_STOPPED') {
            if (data.lastDisplayMessage && !content) content = data.lastDisplayMessage;
            scheduleFinish(300, 'completed');
          }
          if (
            data?.status &&
            (data.status.includes('WAITING') || data.status.includes('PAUSED'))
          ) {
            await handleRequiresInput({
              prompt: data.lastDisplayMessage || 'Aguardando sua resposta.',
              reason: 'session_' + data.status,
              sessionStatus: data.status,
            });
          }
        } catch {
          /* ignore */
        }
      })();
    });

    socket.onAny((eventName, ...args) => {
      if (eventName === 'message' || eventName === 'notification') return;
      if (process.env.MANUS_WS_DEBUG) {
        console.log('[manus-ws] event', eventName, JSON.stringify(args).slice(0, 200));
      }
    });
  });
}

export { shortUID };
