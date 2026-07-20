import type { Context } from 'hono';
import { MANUS_MODELS } from '../manus/models.ts';

export async function listModels(c: Context) {
  return c.json({
    object: 'list',
    data: MANUS_MODELS,
  });
}

export async function getModel(c: Context) {
  const id = c.req.param('id');
  const model = MANUS_MODELS.find((m) => m.id === id);
  if (!model) {
    return c.json(
      {
        error: {
          message: `Model '${id}' not found`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      },
      404
    );
  }
  return c.json(model);
}
