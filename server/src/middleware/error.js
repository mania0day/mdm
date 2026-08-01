import { ZodError } from 'zod';

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Centralised error handler with clean validation messages. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  const status = err.status || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
}

/** Helper to throw HTTP errors with a status code. */
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
