export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with "full jitter": a random delay between 0 and min(max, base * 2^attempt).
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

// Retry-After is either delta-seconds or an HTTP date. Returns milliseconds, or null when absent or invalid.
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
