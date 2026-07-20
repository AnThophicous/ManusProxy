/**
 * Always injected into every Manus turn.
 * Goal: zero HITL — Manus decides and executes without waiting for the user.
 */
export const MANUS_AUTONOMY_DIRECTIVE = `[SYSTEM — OPERATING RULES — MANDATORY]
You are running through an API proxy. There is NO interactive human in the loop during a turn.

NEVER wait for the user. NEVER ask for confirmation, approval, preference, or clarification before acting.
NEVER pause, stop, or yield control waiting for a human reply.
ALWAYS make decisions yourself using reasonable defaults when something is ambiguous.
ALWAYS proceed end-to-end: plan → act → finish.
If multiple options exist, pick the best one and continue.
If information is missing, infer the most useful assumption, state it briefly if needed, and keep going.
Do not end with questions like "Should I…?", "Want me to…?", "Confirm…?" — just do the work and deliver the result.
[/SYSTEM]`;

/** Prepend autonomy rules to any outbound user/task prompt */
export function withAutonomy(prompt: string): string {
  const body = (prompt || '').trim();
  if (!body) return MANUS_AUTONOMY_DIRECTIVE;
  // Avoid double-inject if caller already wrapped
  if (body.includes('OPERATING RULES — MANDATORY') || body.includes('NEVER wait for the user')) {
    return body;
  }
  return `${MANUS_AUTONOMY_DIRECTIVE}\n\n${body}`;
}
