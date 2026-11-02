import { HttpError, type Middleware } from './http.ts';
import type { Counter } from './metrics.ts';

export type FaultMode = 'before' | 'after' | 'mixed';

export type FaultConfig = { rate: number; mode: FaultMode; methods: string[]; random?: () => number };

// Chaos testing: fail a share of write requests either before the handler runs, or after it has
// committed (the client never sees the response). The second case is the one idempotency must survive.
export function faultInjection(config: FaultConfig, injected: Counter): Middleware {
  const random = config.random ?? Math.random;
  return async (req, next) => {
    if (config.rate <= 0 || !config.methods.includes(req.method) || random() >= config.rate) return next();
    const when = config.mode === 'mixed' ? (random() < 0.5 ? 'before' : 'after') : config.mode;
    injected.inc({ when, route: `${req.method} ${req.route}` });
    if (when === 'before') throw new HttpError(503, 'injected_fault', 'Injected fault before processing', undefined, { 'retry-after': '0' });
    await next();
    throw new HttpError(503, 'injected_fault', 'Injected fault after processing; the response was lost', undefined, { 'retry-after': '0' });
  };
}

export function faultConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FaultConfig | undefined {
  const rate = Number(env.FAULT_RATE ?? 0);
  if (!(rate > 0)) return undefined;
  const mode = (env.FAULT_MODE ?? 'mixed') as FaultMode;
  if (!['before', 'after', 'mixed'].includes(mode)) throw new Error('FAULT_MODE must be before, after or mixed');
  return { rate: Math.min(rate, 0.9), mode, methods: ['POST', 'PUT', 'DELETE'] };
}
