import { parse } from "yaml";
import type { RedactMode } from "./config.js";
import { isSensitiveEnvVar } from "./sanitize.js";

/**
 * Swarmpit's stack-compose endpoint escapes `$` as `$$` before returning YAML,
 * while a user-authored compose does not. Comparing the two forms directly
 * reports a change on every line containing a variable reference.
 */
export function unescapeCompose(yaml: string): string {
  return yaml.replace(/\$\$/g, "$");
}

export interface ComposeDiffOptions {
  redact?: RedactMode;
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

function listDelta(before: unknown[], after: unknown[]): ListDelta | undefined {
  const key = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const beforeCounts = new Map<string, number>();
  for (const v of before) beforeCounts.set(key(v), (beforeCounts.get(key(v)) ?? 0) + 1);
  const afterCounts = new Map<string, number>();
  for (const v of after) afterCounts.set(key(v), (afterCounts.get(key(v)) ?? 0) + 1);

  const added: unknown[] = [];
  const removed: unknown[] = [];
  for (const [k, n] of afterCounts) {
    const extra = n - (beforeCounts.get(k) ?? 0);
    for (let i = 0; i < extra; i++) added.push(k);
  }
  for (const [k, n] of beforeCounts) {
    const extra = n - (afterCounts.get(k) ?? 0);
    for (let i = 0; i < extra; i++) removed.push(k);
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
  redact: RedactMode
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
    const show = redact === "none" || (redact === "sensitive" && !isSensitiveEnvVar(name));
    changed.push(show ? { name, from: b.get(name), to: value } : name);
  }

  if (!added.length && !removed.length && !changed.length) return undefined;
  return {
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(changed.length ? { changed } : {}),
  };
}

function serviceDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  redact: RedactMode
): Record<string, unknown> | undefined {
  const delta: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key];
    const a = after[key];

    if (key === "environment") {
      const env = envDelta(b, a, redact);
      if (env) delta.environment = env;
      continue;
    }

    if (JSON.stringify(b) === JSON.stringify(a)) continue;

    if (Array.isArray(b) || Array.isArray(a)) {
      const list = listDelta(Array.isArray(b) ? b : [], Array.isArray(a) ? a : []);
      if (list) delta[key] = list;
      continue;
    }

    if (b && a && typeof b === "object" && typeof a === "object") {
      const nested = serviceDelta(b as Record<string, unknown>, a as Record<string, unknown>, redact);
      if (nested) delta[key] = nested;
      continue;
    }

    delta[key] = { from: b ?? null, to: a ?? null };
  }

  return Object.keys(delta).length ? delta : undefined;
}

function sectionDelta(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  redact: RedactMode
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
      redact
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
    before = (parse(unescapeCompose(beforeYaml || "")) ?? {}) as Record<string, unknown>;
    after = (parse(unescapeCompose(afterYaml || "")) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return {
      changed: (beforeYaml ?? "") !== (afterYaml ?? ""),
      parseError: e instanceof Error ? e.message : String(e),
    };
  }

  const result: ComposeDiff = { changed: false };
  for (const section of ["services", "networks", "volumes", "configs", "secrets"] as const) {
    const d = sectionDelta(
      before[section] as Record<string, unknown> | undefined,
      after[section] as Record<string, unknown> | undefined,
      redact
    );
    if (d) {
      (result as unknown as Record<string, unknown>)[section] = d;
      result.changed = true;
    }
  }

  const skip = new Set(["services", "networks", "volumes", "configs", "secrets"]);
  const otherBefore = Object.fromEntries(Object.entries(before).filter(([k]) => !skip.has(k)));
  const otherAfter = Object.fromEntries(Object.entries(after).filter(([k]) => !skip.has(k)));
  const other = serviceDelta(otherBefore, otherAfter, redact);
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
