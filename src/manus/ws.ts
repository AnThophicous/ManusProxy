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
  | 'error'
  | 'credits_exhausted';

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
  /** Set when Manus reports no credits / quota */
  creditsExhausted?: boolean;
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
 * Manus *agent* mode writes under /home/ubuntu and never emits host tool_calls.
 * Default for this proxy: always chat (or lite). Agent only if MANUS_ALLOW_AGENT=1.
 *
 * MANUS_FORCE_CHAT_WITH_TOOLS=false only matters when MANUS_ALLOW_AGENT=1.
 */
export function resolveTaskModeForTools(
  modelId: string,
  hasHostTools: boolean
): ManusTaskMode {
  const base = resolveTaskMode(modelId);
  const allowAgent =
    process.env.MANUS_ALLOW_AGENT === '1' || process.env.MANUS_ALLOW_AGENT === 'true';

  // Default path: never use agent Build for host coding proxies
  if (!allowAgent) {
    if (base === 'lite') return 'lite';
    return 'chat';
  }

  // Explicit agent allowed — still force chat when host tools present (unless disabled)
  if (hasHostTools) {
    const force =
      process.env.MANUS_FORCE_CHAT_WITH_TOOLS !== '0' &&
      process.env.MANUS_FORCE_CHAT_WITH_TOOLS !== 'false';
    if (force) {
      if (base === 'lite') return 'lite';
      return 'chat';
    }
  }
  return base;
}

function pickStringContent(obj: unknown): string {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  for (const k of ['content', 'text', 'value', 'message', 'delta']) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
  }
  // contents: [{type:'text', value:'...'}]
  if (Array.isArray(rec.contents)) {
    return rec.contents
      .map((c) => {
        if (!c || typeof c !== 'object') return '';
        const p = c as Record<string, unknown>;
        if (typeof p.value === 'string') return p.value;
        if (typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

function extractAssistantText(event: Record<string, unknown>): string {
  const type = String(event.type || '');

  if (type === 'chatDelta' || type === 'chat_delta' || type === 'assistantDelta') {
    const delta = event.delta as Record<string, unknown> | string | undefined;
    if (typeof delta === 'string') return delta;
    const fromDelta = pickStringContent(delta);
    if (fromDelta) return fromDelta;
    // some payloads put incremental text on the event itself
    const direct = pickStringContent(event);
    if (direct && direct !== String(event.type)) return direct;
    return '';
  }

  if (
    (type === 'chat' || type === 'assistantMessage' || type === 'assistant_message') &&
    (event.sender === 'assistant' || event.role === 'assistant' || !event.sender)
  ) {
    return pickStringContent(event) || String(event.content || '');
  }

  // Streaming-ish aliases
  if (type === 'messageDelta' || type === 'textDelta' || type === 'token') {
    return pickStringContent(event.delta) || pickStringContent(event);
  }

  return '';
}

function isAssistantChatEvent(event: Record<string, unknown>): boolean {
  const type = String(event.type || '');
  if (type === 'chatDelta' || type === 'chat_delta' || type === 'assistantDelta') return true;
  if (type === 'messageDelta' || type === 'textDelta' || type === 'token') return true;
  if (type === 'chat' || type === 'assistantMessage' || type === 'assistant_message') {
    return event.sender === 'assistant' || event.role === 'assistant' || !event.sender;
  }
  return false;
}

/** Content that looks like "I'm about to work" — do not close the turn yet */
export function looksLikeTurnPreamble(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.includes('<tool_call') || t.includes('```tool_call')) return false;
  // short intros always treated as preamble when tools expected
  if (t.length < 280) {
    return /vou |irei |deixe|entendi|com certeza|claro|ok[,!.]|certo|primeiro|ambiente|verificar|prepar|cri(ar|ando)|implement|calculador|arquivo|olhada|looking|let me|i('ll| will)|going to|check(ing)? the|plan|estrutura|padr[oõ]es/i.test(
      t
    );
  }
  if (t.length > 2000) return false;
  return /vou (criar|verificar|preparar|escrever|implementar|montar|dar uma)|deixe-me|com certeza|plano para|primeiro[, ]|olhada no|ambiente|let me |i('ll| will) |i'm going to |checking the environment|seguindo os padr/i.test(
    t
  );
}

/** Host expected tools but model only planned — turn is incomplete */
export function isIncompleteHostToolTurn(text: string, hasHostTools: boolean): boolean {
  if (!hasHostTools) return false;
  const t = (text || '').trim();
  if (!t) return true;
  if (hasIncompleteToolMarkup(t)) return true;
  if (t.includes('<tool_call') || t.includes('```tool_call')) {
    // has markup that parses — orchestrator handles; allow complete from WS side
    return false;
  }
  // pure Q&A answers (no file work language) can complete without tools
  const wantsFiles =
    /cri(ar|e)|escrev|implement|arquivo|file|code|html|calculador|workspace|pasta|projeto|componente|script|\.ts|\.js|\.tsx|\.py|\.css/i.test(
      t
    ) || looksLikeTurnPreamble(t);
  return wantsFiles;
}

/** Open tool_call tags without matching close — never end the turn yet */
export function hasIncompleteToolMarkup(text: string): boolean {
  const s = text || '';
  const opens = (s.match(/<tool_call[\s>]/gi) || []).length;
  const closes = (s.match(/<\/tool_call>/gi) || []).length;
  if (opens > closes) return true;
  if (/```tool_call/i.test(s) && !/```tool_call[\s\S]*?```/i.test(s)) return true;
  return false;
}

/** Manus out of free/paid credits — stop nudging and fail cleanly */
export function detectCreditsExhausted(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return false;
  return (
    /cr[eé]ditos?\s+(foram\s+)?(usados|esgotados|insuficientes)/i.test(t) ||
    /seus cr[eé]ditos foram/i.test(t) ||
    /out of credits/i.test(t) ||
    /insufficient\s+(credits?|quota)/i.test(t) ||
    /no credits? (left|remaining|available)/i.test(t) ||
    /atualize seu plano para obter mais cr[eé]ditos/i.test(t) ||
    /upgrade.*(plan|subscription).*credits?/i.test(t) ||
    /get more credits/i.test(t) ||
    /obtenha mais cr[eé]ditos/i.test(t) ||
    /quota\s+(exceeded|exhausted)/i.test(t) ||
    /insufficient_feature_quota/i.test(t)
  );
}

export function stripHostNudgeLeak(text: string): string {
  return (text || '')
    .replace(/\[HOST NUDGE #[\s\S]*?(?=\n\[|$)/gi, '')
    .replace(/You already announced the plan\.[\s\S]*?plain text only\./gi, '')
    .replace(/The Manus cloud sandbox is NOT the user machine\./gi, '')
    .replace(/IMMEDIATELY emit one or more <tool_call>[\s\S]*?<\/tool_call> blocks/gi, '')
    .trim();
}

const CREDITS_EXHAUSTED_USER_MSG =
  'Créditos da Manus esgotados nesta conta. ' +
  'Espere o refresh diário, troque de conta (x-manus-account) ou faça upgrade no manus.im.';

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
  // NOTE: do NOT include bare "pending" — Manus uses it mid-run and false-triggers HITL
  const waitAgent = [
    'waiting_for_user',
    'wait_for_user',
    'need_user',
    'need_user_input',
    'awaiting_user',
    'awaiting_input',
    'user_confirm',
    'idle_waiting',
    'paused_for_user',
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
    // Require explicit user-wait tokens — "waiting" alone is too broad (queue waits)
    const hardWait = [
      'waiting_for_user',
      'wait_for_user',
      'need_user',
      'awaiting_user',
      'awaiting_input',
      'user_confirm',
      'paused_for_user',
    ];
    if (hardWait.some((w) => agentStatus.includes(w))) {
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
  const hasHostTools = Boolean(opts.hasHostTools);
  const taskMode =
    opts.taskMode ??
    resolveTaskModeForTools(opts.model || 'manus', hasHostTools);
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
    let lastActivityAt = Date.now();
    let lastAgentActivityAt = 0;
    let nudgeCount = 0;
    let creditsExhausted = false;
    let turnStatus: ManusTurnStatus = 'completed';
    let requiresInput: ManusRequiresInput | undefined;
    let stopGrace: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const events: unknown[] = [];
    let socket: Socket | null = null;

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const markActivity = (kind: 'text' | 'thought' | 'agent' | 'status' = 'text') => {
      lastActivityAt = Date.now();
      if (kind === 'agent' || kind === 'status') lastAgentActivityAt = Date.now();
    };

    const hasToolMarkup = () =>
      content.includes('<tool_call') || content.includes('```tool_call');

    /**
     * HARD GATE: do not end the turn while Manus is mid-work or only sent a plan.
     * This was the root cause of "Build · Manus · 26s" then silence.
     */
    const canComplete = (reason: 'idle' | 'stopped' | 'session_stopped' | 'timeout'): boolean => {
      // Out of credits → always allow finish (nudging is useless)
      if (creditsExhausted) return true;
      if (agentRunning) {
        console.log(`[manus-ws] block finish (${reason}): agent still running`);
        return false;
      }
      // recent sandbox/tool activity → still working even if status flipped
      if (Date.now() - lastAgentActivityAt < 8_000) {
        console.log(`[manus-ws] block finish (${reason}): recent agent activity`);
        return false;
      }
      if (isIncompleteHostToolTurn(content, hasHostTools) && reason !== 'timeout') {
        console.log(
          `[manus-ws] block finish (${reason}): incomplete host-tool turn chars=${content.length} nudges=${nudgeCount}`
        );
        return false;
      }
      return true;
    };

    const finish = (err?: Error, status?: ManusTurnStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopGrace) clearTimeout(stopGrace);
      clearIdle();
      opts.signal?.removeEventListener('abort', onAbort);
      if (status) turnStatus = status;
      // Never leak host-nudge text into the client-facing body
      content = stripHostNudgeLeak(content);
      if (creditsExhausted && !content.includes('Créditos da Manus')) {
        content = content
          ? `${content}\n\n${CREDITS_EXHAUSTED_USER_MSG}`
          : CREDITS_EXHAUSTED_USER_MSG;
      }
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
            creditsExhausted,
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
          status: creditsExhausted ? 'credits_exhausted' : turnStatus,
          requiresInput,
          creditsExhausted,
        });
      }
    };

    /**
     * Idle-based completion. Incomplete host-tool turns get NUDGED, not closed.
     * Out of credits → finish immediately (no nudge spam).
     */
    const bumpIdle = () => {
      if (settled) return;
      clearIdle();
      markActivity('text');

      if (creditsExhausted || detectCreditsExhausted(content)) {
        creditsExhausted = true;
        idleTimer = setTimeout(() => finish(undefined, 'credits_exhausted'), 150);
        return;
      }

      let idleMs = isChatMode ? 2_500 : 5_000;
      if (agentRunning) idleMs = 15_000;
      else if (isIncompleteHostToolTurn(content, hasHostTools)) idleMs = 20_000;
      else if (hasToolMarkup()) idleMs = 2_000;

      idleTimer = setTimeout(() => {
        if (settled) return;
        if (!(content || sawAssistantChat || reasoning)) return;

        if (creditsExhausted || detectCreditsExhausted(content)) {
          creditsExhausted = true;
          finish(undefined, 'credits_exhausted');
          return;
        }

        if (!canComplete('idle')) {
          // Root recovery: push Manus to emit tool_calls instead of dying
          if (isIncompleteHostToolTurn(content, hasHostTools) && nudgeCount < 2) {
            if (sendContinueNudge('idle_incomplete')) {
              bumpIdle();
              return;
            }
          }
          // still blocked (agent running) — keep waiting
          if (agentRunning || Date.now() - lastAgentActivityAt < 8_000) {
            bumpIdle();
            return;
          }
          // exhausted nudges — finish with whatever we have
          console.log(
            `[manus-ws] idle force-finish after nudges session=${sessionId} chars=${content.length}`
          );
          finish(undefined, 'completed');
          return;
        }

        console.log(
          `[manus-ws] idle finish session=${sessionId} mode=${taskMode} chars=${content.length} tools=${hasHostTools} nudges=${nudgeCount}`
        );
        finish(undefined, 'completed');
      }, idleMs);
    };

    const scheduleFinish = (
      ms = 450,
      status?: ManusTurnStatus,
      reason: 'stopped' | 'session_stopped' = 'stopped'
    ) => {
      if (stopGrace) clearTimeout(stopGrace);
      stopGrace = setTimeout(() => {
        if (settled) return;
        if (creditsExhausted || status === 'credits_exhausted') {
          clearIdle();
          finish(undefined, 'credits_exhausted');
          return;
        }
        if (!canComplete(reason)) {
          if (isIncompleteHostToolTurn(content, hasHostTools) && sendContinueNudge(reason)) {
            bumpIdle();
            return;
          }
          if (agentRunning) {
            bumpIdle();
            return;
          }
        }
        clearIdle();
        finish(undefined, status);
      }, ms);
    };

    const markCreditsExhausted = (source: string) => {
      if (creditsExhausted && settled) return;
      creditsExhausted = true;
      agentRunning = false;
      console.log(`[manus-ws] credits exhausted (${source}) session=${sessionId}`);
      scheduleFinish(150, 'credits_exhausted', 'stopped');
    };

    /** Push a follow-up user_message in-session so Manus actually emits tool_calls */
    const sendContinueNudge = (why: string): boolean => {
      if (settled || !socket?.connected) return false;
      if (creditsExhausted) return false;
      if (detectCreditsExhausted(content)) {
        markCreditsExhausted('nudge_blocked_by_content');
        return false;
      }
      if (nudgeCount >= 2) return false;
      if (!hasHostTools && !looksLikeTurnPreamble(content)) return false;
      nudgeCount += 1;
      markActivity('text');
      // Compact nudge — less noise if it appears in Manus session history
      const nudgeText = [
        `[HOST] Continue with <tool_call>{"name":"…","arguments":{…}}</tool_call> only.`,
        `Use host tools (OpenCode/Codex/builtins). No Manus sandbox. No narration. (#${nudgeCount}/${why})`,
      ].join(' ');

      const payload = {
        id: shortUID(),
        timestamp: Date.now(),
        messageStatus: 'pending',
        type: 'user_message',
        sessionId,
        content: '',
        contents: [{ type: 'text', value: nudgeText }],
        messageType: 'text',
        taskMode: 'chat' as ManusTaskMode,
        attachments: [] as unknown[],
        extData: {} as Record<string, unknown>,
      };
      console.log(
        `[manus-ws] continue nudge #${nudgeCount} session=${sessionId} why=${why}`
      );
      try {
        socket.emit('message', payload);
        return true;
      } catch {
        return false;
      }
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

    console.log(
      `[manus-ws] start session=${sessionId} mode=${taskMode} chatMode=${isChatMode} hostTools=${hasHostTools} model=${opts.model || 'manus'}`
    );

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

    const applyAssistantPiece = async (piece: string, isCumulative = false) => {
      if (!piece) return;
      // Never stream host-nudge echoes into the client
      if (/\[HOST NUDGE|#HOST\]|Continue with <tool_call>/i.test(piece) && piece.length < 500) {
        return;
      }
      let net = '';

      if (isCumulative || (content && piece.startsWith(content) && piece.length > content.length)) {
        if (piece === content) return;
        if (piece.startsWith(content)) {
          net = piece.slice(content.length);
          content = piece;
        } else if (content.startsWith(piece)) {
          return; // older shorter snapshot
        } else if (piece.length >= content.length) {
          // divergent full message — take newer
          net = piece;
          content = piece;
        }
      } else {
        if (!piece) return;
        if (content.endsWith(piece)) return;
        // delta may itself be cumulative sometimes
        if (piece.startsWith(content) && piece.length > content.length) {
          net = piece.slice(content.length);
          content = piece;
        } else {
          content += piece;
          net = piece;
        }
      }

      if (net) {
        sawAssistantChat = true;
        markActivity('text');
        // Credits dead → do NOT stream quota spam to OpenCode; proxy will rotate account
        if (detectCreditsExhausted(content) || detectCreditsExhausted(net)) {
          console.log(
            `[manus-ws] credits message (not streamed to client) session=${sessionId}: ${net.slice(0, 80)}`
          );
          markCreditsExhausted('assistant_text');
          return;
        }
        await opts.handlers?.onDelta?.(net);
        bumpIdle();
      }
    };

    const handleEvent = async (ev: Record<string, unknown>) => {
      if (ev.id) lastEventId = String(ev.id);
      await opts.handlers?.onEvent?.(ev);

      if (process.env.MANUS_WS_DEBUG) {
        console.log(
          `[manus-ws] ev type=${ev.type} sender=${ev.sender || ''} keys=${Object.keys(ev).slice(0, 12).join(',')}`
        );
      }

      const thoughtRaw = extractThought(ev);
      if (thoughtRaw) {
        const { full, net } = mergeThoughtDelta(reasoning, thoughtRaw);
        reasoning = full;
        if (net) {
          markActivity('thought');
          await opts.handlers?.onThought?.(net);
          bumpIdle();
        }
      }

      // Agent desktop / sandbox / tools (optional SSE side-channel)
      const agentEv = toAgentEvent(ev);
      if (agentEv) {
        markActivity('agent');
        await opts.handlers?.onAgentEvent?.(agentEv);
        if (
          agentEv.type === 'toolUsed' ||
          agentEv.type === 'toolUse' ||
          agentEv.type === 'liveStatus' ||
          agentEv.type === 'sandboxUpdate' ||
          agentEv.type === 'statusUpdate'
        ) {
          // any build activity keeps the turn alive
          if (agentEv.status === 'running' || agentEv.agentStatus === 'running') {
            agentRunning = true;
          }
          bumpIdle();
        }
      }

      if (ev.type === 'statusUpdate') {
        const st = String(ev.agentStatus || '').toLowerCase();
        await opts.handlers?.onStatus?.(st, ev);
        markActivity('status');
        if (
          st === 'running' ||
          st === 'thinking' ||
          st === 'working' ||
          st.includes('run') ||
          st.includes('think') ||
          st.includes('work') ||
          st.includes('build')
        ) {
          agentRunning = true;
          bumpIdle();
        }
        if (st === 'stopped' || st === 'done' || st === 'completed' || st === 'idle') {
          agentRunning = false;
        }
      }

      // HITL — only hard user-wait states (pending removed)
      const need = detectRequiresInput(ev);
      if (need) {
        if (!content && need.prompt) {
          content = need.prompt;
          await opts.handlers?.onDelta?.(need.prompt);
        }
        await handleRequiresInput(need);
        return;
      }

      // Streaming + final assistant text (many event type aliases)
      if (isAssistantChatEvent(ev)) {
        const piece = extractAssistantText(ev);
        const type = String(ev.type || '');
        const isDelta =
          type.includes('Delta') ||
          type.includes('delta') ||
          type === 'token' ||
          type === 'textDelta';
        if (piece) {
          await applyAssistantPiece(piece, !isDelta);
        }
      }

      // status=stopped must NOT kill incomplete host-tool turns (was root bug ~26s)
      if (ev.type === 'statusUpdate') {
        const st = String(ev.agentStatus || '').toLowerCase();
        if (st === 'stopped' || st === 'done' || st === 'completed') {
          if (canComplete('stopped')) {
            if (sawAssistantChat || content) scheduleFinish(600, 'completed', 'stopped');
            else scheduleFinish(1_500, 'completed', 'stopped');
          } else {
            console.log(
              `[manus-ws] ignore early stopped session=${sessionId} incomplete tools turn`
            );
            if (isIncompleteHostToolTurn(content, hasHostTools)) {
              sendContinueNudge('status_stopped_incomplete');
            }
            bumpIdle();
          }
        }
      }
    };

    const unwrapAndHandle = async (raw: unknown) => {
      if (raw == null) return;
      if (Array.isArray(raw)) {
        for (const item of raw) await unwrapAndHandle(item);
        return;
      }
      if (typeof raw !== 'object') return;
      const msg = raw as Record<string, unknown>;

      // Standard envelope: { type: 'event', event: {...} }
      if (msg.type === 'event' && msg.event && typeof msg.event === 'object') {
        await handleEvent(msg.event as Record<string, unknown>);
        return;
      }
      // Nested data.event
      if (msg.data && typeof msg.data === 'object') {
        const data = msg.data as Record<string, unknown>;
        if (data.type === 'event' && data.event && typeof data.event === 'object') {
          await handleEvent(data.event as Record<string, unknown>);
          return;
        }
        if (data.type) {
          await handleEvent(data);
          return;
        }
      }
      // Direct event with type (chatDelta, chat, statusUpdate, …)
      if (msg.type) {
        await handleEvent(msg);
      }
    };

    // Serialize handlers — parallel async was racing content/idle/finish
    let msgChain: Promise<void> = Promise.resolve();
    socket.on('message', (raw: unknown) => {
      msgChain = msgChain
        .then(async () => {
          events.push(raw);
          await unwrapAndHandle(raw);
        })
        .catch((e) => {
          console.warn('[manus-ws] message handler error', e);
        });
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
            if (data.lastDisplayMessage && !content) {
              content = data.lastDisplayMessage;
              sawAssistantChat = true;
            }
            if (canComplete('session_stopped')) {
              scheduleFinish(400, 'completed', 'session_stopped');
            } else {
              console.log(
                `[manus-ws] ignore SESSION_STATUS_STOPPED (incomplete) session=${sessionId}`
              );
              if (isIncompleteHostToolTurn(content, hasHostTools)) {
                sendContinueNudge('session_stopped_incomplete');
              }
              bumpIdle();
            }
          }
          // Only true user-wait session statuses — not generic PENDING mid-run
          if (
            data?.status &&
            (data.status.includes('WAITING_FOR_USER') ||
              data.status.includes('NEED_USER') ||
              data.status.includes('AWAITING_USER') ||
              data.status === 'SESSION_STATUS_PAUSED')
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
