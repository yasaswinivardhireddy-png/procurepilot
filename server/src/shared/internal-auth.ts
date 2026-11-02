import { HttpError, type Middleware, type Request } from './http.ts';
import { safeEqual } from './ids.ts';

const USER_ID_RE = /^u_[a-z0-9_]{1,40}$/;

// Internal services accept calls only from the gateway or each other (shared service token) and
// trust the x-user-id the gateway resolved from the session.
export function internalAuth(token: string): Middleware {
  return async (req, next) => {
    const provided = req.header('x-internal-token');
    if (!provided || !safeEqual(provided, token)) throw new HttpError(401, 'unauthorized', 'Missing or invalid service token');
    const userId = req.header('x-user-id');
    if (userId !== undefined) {
      if (!USER_ID_RE.test(userId)) throw new HttpError(400, 'invalid_user', 'Invalid x-user-id header');
      req.state.userId = userId;
    }
    return next();
  };
}

export function requireUserId(req: Request): string {
  if (!req.state.userId) throw new HttpError(401, 'unauthorized', 'A user is required for this call');
  return req.state.userId;
}
