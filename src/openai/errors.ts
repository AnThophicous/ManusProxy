export function toErrorBody(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) {
    return {
      error: {
        message: 'Request cancelled',
        type: 'cancelled',
        param: null,
        code: 'cancelled',
      },
    };
  }
  return {
    error: {
      message,
      type: 'server_error',
      param: null,
      code: 'manus_proxy_error',
    },
  };
}

export function statusFromError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) return 499 as number; // client closed
  if (/login|sess[aã]o|unauthorized|401/i.test(message)) return 401;
  if (/not found|404/i.test(message)) return 404;
  if (/invalid|missing required/i.test(message)) return 400;
  return 500;
}
