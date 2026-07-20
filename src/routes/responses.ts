import type { Context } from 'hono';
import type { ResponsesRequest } from '../openai/types.ts';
import { createSseResponse, wantsStream } from '../openai/sse.ts';
import { runResponsesNonStream, runResponsesStream } from '../orchestrator/run.ts';
import { responseStore } from '../store/response-store.ts';
import { statusFromError, toErrorBody } from '../openai/errors.ts';
import { accountFromRequest } from '../http/account.ts';
import { cancelRun, getRun, listRuns } from '../runtime/active-runs.ts';

export async function createResponse(c: Context) {
  try {
    const body: ResponsesRequest = await c.req.json();
    const accountId = accountFromRequest(c, body as { account?: string });

    if (!body.model) {
      return c.json(
        {
          error: {
            message: 'Missing required parameter: model',
            type: 'invalid_request_error',
            param: 'model',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    if (body.input == null && !body.previous_response_id && !body.last_response_id) {
      return c.json(
        {
          error: {
            message: 'Missing required parameter: input',
            type: 'invalid_request_error',
            param: 'input',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // Default: ALWAYS stream unless stream: false
    if (wantsStream(body)) {
      body.stream = true;
      return createSseResponse(c, async (writer) => {
        await runResponsesStream(body, writer, accountId);
      });
    }

    const response = await runResponsesNonStream(body, accountId);
    return c.json(response);
  } catch (err: unknown) {
    console.error('Error in createResponse:', err);
    return c.json(toErrorBody(err), statusFromError(err) as 400 | 401 | 404 | 500);
  }
}

export async function getResponse(c: Context) {
  try {
    const id = c.req.param('id')!;
    const rec = responseStore.get(id);
    if (!rec) {
      return c.json(
        {
          error: {
            message: `Response with id '${id}' not found.`,
            type: 'invalid_request_error',
            param: 'id',
            code: 'not_found',
          },
        },
        404
      );
    }
    return c.json(rec.response);
  } catch (err: unknown) {
    return c.json(toErrorBody(err), statusFromError(err) as 400 | 401 | 404 | 500);
  }
}

export async function deleteResponse(c: Context) {
  try {
    const id = c.req.param('id')!;
    // cancel if still running
    await cancelRun(id, 'deleted');
    const ok = responseStore.delete(id);
    if (!ok) {
      return c.json(
        {
          error: {
            message: `Response with id '${id}' not found.`,
            type: 'invalid_request_error',
            param: 'id',
            code: 'not_found',
          },
        },
        404
      );
    }
    return c.json({ id, object: 'response', deleted: true });
  } catch (err: unknown) {
    return c.json(toErrorBody(err), statusFromError(err) as 400 | 401 | 404 | 500);
  }
}

/**
 * Cancel an in-flight generation.
 * - Works while stream is open (registered in active-runs)
 * - Also accepts chat completion ids (chatcmpl-…)
 * - Sends stop signals to Manus WS + aborts local AbortController
 */
export async function cancelResponse(c: Context) {
  const id = c.req.param('id')!;
  const run = getRun(id);
  const result = await cancelRun(id, 'api_cancel');

  if (result.found && run) {
    // Update stored response if any
    const rec = responseStore.get(id);
    if (rec) {
      rec.response.status = 'cancelled';
      rec.response.completed_at = Math.floor(Date.now() / 1000);
      rec.response.metadata = {
        ...(rec.response.metadata || {}),
        cancelled: true,
        cancel_reason: 'api_cancel',
      };
      responseStore.put(rec);
    }
    return c.json({
      id,
      object: run.kind === 'chat' ? 'chat.completion' : 'response',
      status: 'cancelled',
      cancelled: true,
      manus_session_id: run.manusSessionId,
    });
  }

  // Not in-flight — mark stored response cancelled if present
  const rec = responseStore.get(id);
  if (rec) {
    rec.response.status = 'cancelled';
    rec.response.metadata = {
      ...(rec.response.metadata || {}),
      cancelled: true,
      cancel_reason: 'api_cancel_late',
    };
    responseStore.put(rec);
    return c.json({
      id,
      object: 'response',
      status: 'cancelled',
      cancelled: true,
      note: 'Run already finished; stored response marked cancelled.',
    });
  }

  return c.json(
    {
      error: {
        message: `No active or stored run with id '${id}'.`,
        type: 'invalid_request_error',
        param: 'id',
        code: 'not_found',
      },
    },
    404
  );
}

export async function listActiveRuns(c: Context) {
  return c.json({
    active: listRuns().map((r) => ({
      id: r.id,
      kind: r.kind,
      accountId: r.accountId,
      manusSessionId: r.manusSessionId,
      startedAt: r.startedAt,
      ageMs: Date.now() - r.startedAt,
    })),
  });
}
