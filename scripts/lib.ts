import { rmSync } from 'node:fs';
import { cpus } from 'node:os';

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export type Audit = { balanced: boolean; orders: number; duplicateIdempotencyKeys: number };

export async function fetchAudit(ordersUrl: string, internalToken: string): Promise<Audit> {
  const res = await fetch(`${ordersUrl}/internal/audit`, { headers: { 'x-internal-token': internalToken } });
  return (await res.json()) as Audit;
}

// Sums a Prometheus metric across the series whose labels contain every given fragment.
export function metricSum(text: string, name: string, ...labelFragments: string[]): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (labelFragments.every((f) => line.includes(f))) sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}

export function machine(): string {
  const cores = cpus();
  return `${cores[0]?.model.trim() ?? 'unknown CPU'}, ${cores.length} logical cores, Node ${process.version} on ${process.platform}`;
}

export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // SQLite files can stay locked briefly on Windows; the OS cleans the temp folder later.
  }
}

export const loadUser = (i: number) => `u_load_${String(i + 1).padStart(3, '0')}`;
