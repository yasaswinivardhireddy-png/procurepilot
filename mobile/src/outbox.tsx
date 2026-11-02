import { ApiError, Outbox, type CheckoutRequest, type Order, type OutboxEntry } from '@procurepilot/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSession } from './session';
import { deviceStorage } from './storage';

export type SubmitResult = { status: 'sent'; order: Order } | { status: 'queued' } | { status: 'failed'; message: string; code?: string };

type OutboxValue = {
  entries: OutboxEntry[];
  submitCheckout(request: CheckoutRequest): Promise<SubmitResult>;
  flush(): Promise<void>;
};

const OutboxContext = createContext<OutboxValue | null>(null);

// Checkout goes through a device-side outbox: the request and its idempotency key are saved before
// the first attempt, so a dropped connection, a timeout or a killed app can never lose an order or
// place it twice. Pending checkouts are retried when the app returns to the foreground and every 15 s.
export function OutboxProvider({ children }: { children: ReactNode }) {
  const { client, user } = useSession();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const sent = useRef(new Map<string, Order>());
  const failed = useRef(new Map<string, unknown>());

  const outbox = useMemo(() => {
    if (!user) return null;
    return new Outbox(
      deviceStorage,
      (entry) => {
        if (entry.kind !== 'checkout') throw new Error(`Unknown outbox entry: ${entry.kind}`);
        return client.checkout(entry.payload as CheckoutRequest, { idempotencyKey: entry.idempotencyKey });
      },
      { storageKey: `pp-outbox:v1:${user.id}` },
    );
  }, [client, user]);

  useEffect(() => {
    if (!outbox) {
      setEntries([]);
      return;
    }
    const unsubscribe = outbox.subscribe((event) => {
      if (event.type === 'changed') setEntries(event.entries);
      if (event.type === 'sent') sent.current.set(event.entry.id, event.result as Order);
      if (event.type === 'failed') failed.current.set(event.entry.id, event.error);
    });
    void outbox.load().then(() => outbox.flush());
    const foreground = AppState.addEventListener('change', (status) => {
      if (status === 'active') void outbox.flush();
    });
    const timer = setInterval(() => {
      if (outbox.entries().some((e) => e.status === 'pending')) void outbox.flush();
    }, 15_000);
    return () => {
      unsubscribe();
      foreground.remove();
      clearInterval(timer);
    };
  }, [outbox]);

  const submitCheckout = useCallback(
    async (request: CheckoutRequest): Promise<SubmitResult> => {
      if (!outbox) return { status: 'failed', message: 'Sign in to place orders' };
      const entry = await outbox.enqueue('checkout', request);
      await outbox.flush();
      const order = sent.current.get(entry.id);
      if (order) return { status: 'sent', order };
      const error = failed.current.get(entry.id);
      if (error) {
        await outbox.discard(entry.id);
        return { status: 'failed', message: (error as Error).message, code: error instanceof ApiError ? error.code : undefined };
      }
      return { status: 'queued' };
    },
    [outbox],
  );

  const flush = useCallback(async () => {
    await outbox?.flush();
  }, [outbox]);

  const value = useMemo(() => ({ entries, submitCheckout, flush }), [entries, submitCheckout, flush]);
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxValue {
  const value = useContext(OutboxContext);
  if (!value) throw new Error('useOutbox must be used inside OutboxProvider');
  return value;
}

// Runs the callback whenever a queued order leaves the outbox, so screens can refresh.
export function useOutboxDelivered(callback: () => void): void {
  const { entries } = useOutbox();
  const count = entries.length;
  const previous = useRef(count);
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (count < previous.current) latest.current();
    previous.current = count;
  }, [count]);
}
