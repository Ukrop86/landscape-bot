import { Router, type RequestHandler } from "express";

/**
 * An express.Router whose route handlers may be async.
 *
 * Express 4 calls a handler and ignores whatever it returns, so a rejected
 * promise from `async (req, res) => …` reaches nobody: Node sees an unhandled
 * rejection and kills the process. That is how one 403 from Google Drive took
 * the whole mini-app offline for every brigade mid-day.
 *
 * Every verb registered here forwards a rejection to `next`, so it lands in the
 * error middleware in index.ts and the caller gets a 500 instead of a socket
 * that never answers. `use` is deliberately NOT wrapped: Express tells error
 * middleware apart by its arity, and wrapping would break that.
 */
const wrap =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (e) {
      next(e);
    }
  };

const VERBS = ["get", "post", "put", "patch", "delete", "all"] as const;

export function asyncRouter(): Router {
  const router = Router();
  for (const verb of VERBS) {
    const original = router[verb].bind(router) as (...args: unknown[]) => Router;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any)[verb] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === "function" ? wrap(a as RequestHandler) : a)));
  }
  return router;
}
