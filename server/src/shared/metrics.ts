// Minimal Prometheus-format metrics: counters, gauges and histograms with labels.
type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const keys = Object.keys(all);
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(all[k]!)}"`).join(',')}}`;
}

function keyOf(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('|');
}

interface Metric {
  render(): string;
}

export class Counter implements Metric {
  name: string;
  help: string;
  #series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(labels);
    const series = this.#series.get(key);
    if (series) series.value += by;
    else this.#series.set(key, { labels, value: by });
  }

  get(labels: Labels = {}): number {
    return this.#series.get(keyOf(labels))?.value ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const s of this.#series.values()) sum += s.value;
    return sum;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.#series.values()) lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  name: string;
  help: string;
  #series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels, value: number): void {
    this.#series.set(keyOf(labels), { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const s of this.#series.values()) lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    return lines.join('\n');
  }
}

export const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class Histogram implements Metric {
  name: string;
  help: string;
  buckets: number[];
  #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: number[] = LATENCY_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = keyOf(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) series.counts[i]!++;
    series.sum += value;
    series.count++;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.#series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${formatLabels(s.labels, { le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${formatLabels(s.labels, { le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  #metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.#getOrCreate(name, () => new Counter(name, help)) as Counter;
  }

  gauge(name: string, help: string): Gauge {
    return this.#getOrCreate(name, () => new Gauge(name, help)) as Gauge;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    return this.#getOrCreate(name, () => new Histogram(name, help, buckets)) as Histogram;
  }

  render(): string {
    return `${[...this.#metrics.values()].map((m) => m.render()).join('\n')}\n`;
  }

  #getOrCreate(name: string, create: () => Metric): Metric {
    let metric = this.#metrics.get(name);
    if (!metric) {
      metric = create();
      this.#metrics.set(name, metric);
    }
    return metric;
  }
}
