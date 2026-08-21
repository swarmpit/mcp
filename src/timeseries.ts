export type Aggregation = "avg" | "max" | "min";

export interface ReduceOptions {
  /** Number of buckets to collapse each series into. */
  points?: number;
  /** How to combine the samples inside a bucket. */
  agg?: Aggregation;
  /** Case-insensitive substring filter on the series name. */
  match?: string;
  /** Drop the sample arrays and keep only per-metric statistics. */
  statsOnly?: boolean;
}

interface Series {
  time?: unknown[];
  [metric: string]: unknown;
}

const NAME_KEYS = ["name", "service", "task", "node", "nodeName", "serviceName"];

function isSeries(value: unknown): value is Series {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.time)) return false;
  return Object.entries(v).some(
    ([k, val]) => k !== "time" && Array.isArray(val) && val.every((n) => typeof n === "number")
  );
}

function seriesName(s: Series): string | undefined {
  for (const key of NAME_KEYS) {
    const v = s[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function aggregate(values: number[], agg: Aggregation): number {
  if (values.length === 0) return 0;
  const n =
    agg === "max"
      ? Math.max(...values)
      : agg === "min"
        ? Math.min(...values)
        : values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(n * 1000) / 1000;
}

/** Split [0..length) into at most `buckets` contiguous ranges. */
function bucketRanges(length: number, buckets: number): [number, number][] {
  const count = Math.min(buckets, length);
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    ranges.push([Math.floor((i * length) / count), Math.floor(((i + 1) * length) / count)]);
  }
  return ranges;
}

function stats(values: number[]) {
  if (values.length === 0) return undefined;
  return {
    min: aggregate(values, "min"),
    max: aggregate(values, "max"),
    avg: aggregate(values, "avg"),
    last: Math.round(values[values.length - 1] * 1000) / 1000,
  };
}

function reduceSeries(s: Series, opts: Required<Pick<ReduceOptions, "points" | "agg" | "statsOnly">>): Series {
  const time = (s.time ?? []) as unknown[];
  const metrics = Object.entries(s).filter(
    ([k, v]) => k !== "time" && Array.isArray(v) && v.every((n) => typeof n === "number")
  ) as [string, number[]][];

  const out: Series = {};
  for (const [k, v] of Object.entries(s)) {
    if (k !== "time" && !metrics.some(([m]) => m === k)) out[k] = v;
  }

  out.samples = time.length;
  if (time.length) {
    out.from = time[0];
    out.to = time[time.length - 1];
  }

  const summary: Record<string, unknown> = {};
  for (const [metric, values] of metrics) {
    const s = stats(values);
    if (s) summary[metric] = s;
  }
  if (Object.keys(summary).length) out.stats = summary;

  if (opts.statsOnly || time.length === 0) return out;

  const ranges = bucketRanges(time.length, opts.points);
  if (ranges.length < time.length) {
    out.downsampled = { to: ranges.length, agg: opts.agg };
  }
  out.time = ranges.map(([, end]) => time[end - 1]);
  for (const [metric, values] of metrics) {
    out[metric] = ranges.map(([start, end]) => aggregate(values.slice(start, end), opts.agg));
  }
  return out;
}

/**
 * Walk an arbitrary timeseries payload and shrink every series it contains.
 * Swarmpit returns parallel arrays (`{ time: [...], cpu: [...] }`), sometimes
 * bare, sometimes wrapped (`{ cpu: { service, time, cpu } }`), and the raw
 * responses regularly exceed 100KB — far past what's useful in context.
 */
export function reduceTimeseries(data: unknown, options: ReduceOptions = {}): unknown {
  const opts = {
    points: options.points ?? 12,
    agg: options.agg ?? "avg",
    statsOnly: options.statsOnly ?? false,
  };
  const match = options.match?.toLowerCase();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk).filter((v) => v !== undefined);
    }
    if (isSeries(value)) {
      if (match) {
        const name = seriesName(value);
        if (!name || !name.toLowerCase().includes(match)) return undefined;
      }
      return reduceSeries(value, opts);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      let kept = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const w = walk(v);
        if (w === undefined) continue;
        out[k] = w;
        kept++;
      }
      // A wrapper whose only content was filtered out disappears with it.
      return kept === 0 && Object.keys(value as object).length > 0 ? undefined : out;
    }
    return value;
  };

  return walk(data) ?? [];
}

export interface LogFilterOptions {
  /** Case-insensitive substring, or /regex/ when wrapped in slashes. */
  grep?: string;
  /** Keep only the last N entries after filtering. */
  tail?: number;
}

export interface LogFilterResult {
  entries: unknown[];
  total: number;
  returned: number;
  dropped?: { byGrep?: number; byTail?: number };
}

function lineOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const line = (entry as Record<string, unknown>).line;
    if (typeof line === "string") return line;
  }
  return JSON.stringify(entry);
}

/**
 * Filter log entries before they reach the model. A busy service can return
 * tens of thousands of lines; paying for all of them to find one stack trace
 * is the single largest avoidable token cost in this server.
 */
export function filterLogs(entries: unknown[], options: LogFilterOptions = {}): LogFilterResult {
  const total = entries.length;
  let working = entries;
  const dropped: { byGrep?: number; byTail?: number } = {};

  if (options.grep) {
    const raw = options.grep;
    const asRegex = raw.length > 1 && raw.startsWith("/") && raw.lastIndexOf("/") > 0;
    let test: (line: string) => boolean;
    if (asRegex) {
      const end = raw.lastIndexOf("/");
      // Explicit /regex/ is case-sensitive unless it says otherwise; only the
      // plain-substring form is forgiving about case.
      const re = new RegExp(raw.slice(1, end), raw.slice(end + 1));
      test = (line) => re.test(line);
    } else {
      const needle = raw.toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const before = working.length;
    working = working.filter((e) => test(lineOf(e)));
    if (before !== working.length) dropped.byGrep = before - working.length;
  }

  if (options.tail !== undefined && working.length > options.tail) {
    dropped.byTail = working.length - options.tail;
    working = working.slice(-options.tail);
  }

  return {
    entries: working,
    total,
    returned: working.length,
    ...(Object.keys(dropped).length ? { dropped } : {}),
  };
}
