import { parseComposeDocument } from "./compose-yaml.js";
import type { RedactMode } from "./config.js";
import { isSensitiveEnvVar } from "./sanitize.js";

export interface ComposeDiffOptions {
  redact?: RedactMode;
  sensitiveValues?: ReadonlySet<string>;
}

interface ListDelta {
  added?: unknown[];
  removed?: unknown[];
}

interface EnvDelta {
  added?: string[];
  removed?: string[];
  changed?: (string | { name: string; from: unknown; to: unknown })[];
}

interface RedactionContext {
  names: Set<string>;
  values: Set<string>;
}

const UNORDERED_FIELDS = new Set(["ports", "networks", "volumes", "secrets", "configs", "cap_add", "cap_drop", "expose"]);

function listDelta(before: unknown[], after: unknown[]): ListDelta | undefined {
  const key = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const beforeCounts = new Map<string, number>();
  for (const v of before) beforeCounts.set(key(v), (beforeCounts.get(key(v)) ?? 0) + 1);
  const afterCounts = new Map<string, number>();
  for (const v of after) afterCounts.set(key(v), (afterCounts.get(key(v)) ?? 0) + 1);

  const added: unknown[] = [];
  const removed: unknown[] = [];
  const values = new Map([...before, ...after].map((v) => [key(v), v]));
  for (const [k, n] of afterCounts) {
    const extra = n - (beforeCounts.get(k) ?? 0);
    for (let i = 0; i < extra; i++) added.push(values.get(k));
  }
  for (const [k, n] of beforeCounts) {
    const extra = n - (afterCounts.get(k) ?? 0);
    for (let i = 0; i < extra; i++) removed.push(values.get(k));
  }
  if (!added.length && !removed.length) return undefined;
  return { ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) };
}

/** Compose accepts `KEY: value` maps and `- KEY=value` lists; normalize both. */
function normalizeEnv(value: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq === -1) out.set(entry, null);
      else out.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.set(k, v === null || v === undefined ? null : String(v));
    }
  }
  return out;
}

function envDelta(
  before: unknown,
  after: unknown,
  redact: RedactMode,
  context: RedactionContext
): EnvDelta | undefined {
  const b = normalizeEnv(before);
  const a = normalizeEnv(after);

  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const changed: EnvDelta["changed"] = [];

  for (const [name, value] of a) {
    if (!b.has(name) || b.get(name) === value) continue;
    // Values are only shown when the redaction mode would have shown them
    // anyway — never widen what reaches the model.
    const show = redact === "none" || (redact === "sensitive" && !isSensitiveEnvVar(name)
      && !context.values.has(value ?? "") && !context.values.has(b.get(name) ?? ""));
    changed.push(show ? { name, from: b.get(name), to: value } : name);
  }

  if (!added.length && !removed.length && !changed.length) return undefined;
  return {
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(changed.length ? { changed } : {}),
  };
}

function displayValue(
  value: unknown,
  redact: RedactMode,
  context: RedactionContext,
  key = "",
  environment = false
): unknown {
  if (redact === "none" || value === null || value === undefined) return value;
  if (typeof value !== "object" && context.values.has(String(value))) return "[REDACTED]";
  const envKey = environment || context.names.has(key) || /^[A-Z_][A-Z0-9_]*$/.test(key);
  if (envKey && (redact === "all" || isSensitiveEnvVar(key))) return "[REDACTED]";
  if (typeof value === "string") {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s.exec(value);
    if (match && (redact === "all" || isSensitiveEnvVar(match[1]) || context.values.has(match[2]))) {
      return `${match[1]}=[REDACTED]`;
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => displayValue(entry, redact, context));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
      name, displayValue(entry, redact, context, name, key === "environment"),
    ]));
  }
  return value;
}

function serviceDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  redact: RedactMode,
  context: RedactionContext
): Record<string, unknown> | undefined {
  const delta: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key];
    const a = after[key];

    if (key === "environment") {
      const env = envDelta(b, a, redact, context);
      if (env) delta.environment = env;
      continue;
    }

    if (JSON.stringify(b) === JSON.stringify(a)) continue;

    if (Array.isArray(b) || Array.isArray(a)) {
      if (UNORDERED_FIELDS.has(key) && Array.isArray(b) && Array.isArray(a)) {
        const list = listDelta(b, a);
        if (list) delta[key] = displayValue(list, redact, context, key);
      } else {
        delta[key] = {
          from: displayValue(b ?? null, redact, context, key),
          to: displayValue(a ?? null, redact, context, key),
        };
      }
      continue;
    }

    if (b && a && typeof b === "object" && typeof a === "object") {
      const nested = serviceDelta(b as Record<string, unknown>, a as Record<string, unknown>, redact, context);
      if (nested) delta[key] = nested;
      continue;
    }

    delta[key] = {
      from: displayValue(b ?? null, redact, context, key),
      to: displayValue(a ?? null, redact, context, key),
    };
  }

  return Object.keys(delta).length ? delta : undefined;
}

function sectionDelta(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  redact: RedactMode,
  context: RedactionContext
) {
  const b = before ?? {};
  const a = after ?? {};
  const added = Object.keys(a).filter((k) => !(k in b));
  const removed = Object.keys(b).filter((k) => !(k in a));
  const changed: Record<string, unknown> = {};

  for (const name of Object.keys(a)) {
    if (!(name in b)) continue;
    const d = serviceDelta(
      (b[name] ?? {}) as Record<string, unknown>,
      (a[name] ?? {}) as Record<string, unknown>,
      redact,
      context
    );
    if (d) changed[name] = d;
  }

  const hasChange = added.length || removed.length || Object.keys(changed).length;
  if (!hasChange) return undefined;
  return {
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(Object.keys(changed).length ? { changed } : {}),
  };
}

export interface ComposeDiff {
  changed: boolean;
  services?: unknown;
  networks?: unknown;
  volumes?: unknown;
  configs?: unknown;
  secrets?: unknown;
  other?: unknown;
  parseError?: string;
  /** Env var names whose value differs, regardless of whether it was shown. */
  secretsChanged?: string[];
}

/**
 * Structural comparison of two compose documents. Reports what changed per
 * service rather than per line, so duplicate and reordered lines can't hide a
 * change and the model doesn't have to re-derive which service a line belongs to.
 */
export function diffCompose(
  beforeYaml: string,
  afterYaml: string,
  options: ComposeDiffOptions = {}
): ComposeDiff {
  const redact = options.redact ?? "all";

  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = (parseComposeDocument(beforeYaml || "").toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
    after = (parseComposeDocument(afterYaml || "").toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
  } catch {
    return {
      changed: (beforeYaml ?? "") !== (afterYaml ?? ""),
      parseError: "Invalid compose YAML or aliases",
    };
  }

  const result: ComposeDiff = { changed: false };
  const context: RedactionContext = { names: new Set(), values: new Set(options.sensitiveValues) };
  for (const document of [before, after]) {
    for (const service of Object.values(document.services ?? {}) as Record<string, unknown>[]) {
      for (const [name, value] of normalizeEnv(service?.environment)) {
        context.names.add(name);
        if (value !== null && (redact === "all" || (redact === "sensitive" && isSensitiveEnvVar(name)))) {
          context.values.add(value);
        }
      }
    }
  }
  for (const section of ["services", "networks", "volumes", "configs", "secrets"] as const) {
    const d = sectionDelta(
      before[section] as Record<string, unknown> | undefined,
      after[section] as Record<string, unknown> | undefined,
      redact,
      context
    );
    if (d) {
      (result as unknown as Record<string, unknown>)[section] = d;
      result.changed = true;
    }
  }

  const skip = new Set(["services", "networks", "volumes", "configs", "secrets"]);
  const otherBefore = Object.fromEntries(Object.entries(before).filter(([k]) => !skip.has(k)));
  const otherAfter = Object.fromEntries(Object.entries(after).filter(([k]) => !skip.has(k)));
  const other = serviceDelta(otherBefore, otherAfter, redact, context);
  if (other) {
    result.other = other;
    result.changed = true;
  }

  const secretsChanged = collectChangedEnvNames(before, after);
  if (secretsChanged.length) result.secretsChanged = secretsChanged;

  return result;
}

/** Names of env vars whose value differs anywhere in the document. */
function collectChangedEnvNames(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const names = new Set<string>();
  const beforeServices = (before.services ?? {}) as Record<string, Record<string, unknown>>;
  const afterServices = (after.services ?? {}) as Record<string, Record<string, unknown>>;

  for (const [name, spec] of Object.entries(afterServices)) {
    const b = normalizeEnv(beforeServices[name]?.environment);
    const a = normalizeEnv(spec?.environment);
    for (const [k, v] of a) {
      if (b.has(k) && b.get(k) !== v) names.add(k);
    }
  }
  return [...names];
}
