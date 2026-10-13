import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
import type { SwarmpitService, SwarmpitEnvVar } from "./types.js";

const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /pass/i,
  /secret/i,
  /token/i,
  /key/i,
  /auth/i,
  /credential/i,
  /private/i,
  /connection.?string/i,
  /dsn/i,
];

let extraPatterns: RegExp[] = [];

export function setExtraRedactPatterns(patterns: string[]): void {
  extraPatterns = patterns.map((p) => new RegExp(p, "i"));
}

export function isSensitiveEnvVar(name: string): boolean {
  return DEFAULT_SENSITIVE_PATTERNS.some((p) => p.test(name))
    || extraPatterns.some((p) => p.test(name));
}

function redactEnvVars(
  variables: SwarmpitEnvVar[] | undefined,
  redactAll: boolean
): SwarmpitEnvVar[] | undefined {
  if (!variables) return undefined;
  return variables.map((v) => ({
    name: v.name,
    value: redactAll || isSensitiveEnvVar(v.name) ? "[REDACTED]" : v.value,
  }));
}

export function sanitizeService(
  service: SwarmpitService,
  redactAll = true
): SwarmpitService {
  return {
    ...service,
    variables: redactEnvVars(service.variables, redactAll) ?? [],
    secrets: service.secrets?.map(({ id, secretName, secretTarget }) => ({
      id,
      secretName,
      secretTarget,
    })) ?? [],
    configs: service.configs?.map(({ id, configName, configTarget }) => ({
      id,
      configName,
      configTarget,
    })) ?? [],
  };
}

export function sanitizeServices(
  services: SwarmpitService[],
  redactAll = true
): SwarmpitService[] {
  return services.map((s) => sanitizeService(s, redactAll));
}

/**
 * Sanitize a Docker Compose YAML string by redacting environment variable
 * values that look sensitive. Handles both forms:
 *
 *   environment:
 *     DATABASE_PASSWORD: supersecret     →  DATABASE_PASSWORD: [REDACTED]
 *     - DATABASE_PASSWORD=supersecret    →  - DATABASE_PASSWORD=[REDACTED]
 */
export function sanitizeComposeYaml(yaml: string, redactAll = true): string {
  if (!yaml) return yaml;

  // Key-value form:  SOME_KEY: some_value
  const sanitized = yaml.replace(
    /^(\s+)([A-Z_][A-Z0-9_]*):\s*(.+)$/gm,
    (match, indent: string, key: string, value: string) => {
      // Skip non-env-var-looking keys (lowercase, contains dots, etc.)
      if (key !== key.toUpperCase()) return match;
      // Skip values that look like YAML references, objects, or arrays
      if (value.startsWith("&") || value.startsWith("*") || value.startsWith("{") || value.startsWith("[")) return match;
      if (redactAll || isSensitiveEnvVar(key)) {
        return `${indent}${key}: [REDACTED]`;
      }
      return match;
    }
  );

  // List form:  - SOME_KEY=some_value
  const listed = sanitized.replace(
    /^(\s+-\s+)([A-Z_][A-Z0-9_]*)=(.+)$/gm,
    (match, prefix: string, key: string) => {
      if (redactAll || isSensitiveEnvVar(key)) {
        return `${prefix}${key}=[REDACTED]`;
      }
      return match;
    }
  );

  // Quoted list form:  - "SOME_KEY=some_value"  (previously passed through unredacted)
  return listed.replace(
    /^(\s+-\s+)(["'])([A-Z_][A-Z0-9_]*)=(.*)\2[ \t\r]*(?:#.*)?$/gm,
    (match, prefix: string, quote: string, key: string) => {
      if (redactAll || isSensitiveEnvVar(key)) {
        return `${prefix}${quote}${key}=[REDACTED]${quote}`;
      }
      return match;
    }
  );
}

/**
 * Resolve $env:VAR_NAME references in a compose YAML string.
 * Plain values pass through unchanged. Only $env: prefixed values
 * are resolved from process.env.
 *
 *   DATABASE_PASSWORD: $env:MY_DB_PASS  →  DATABASE_PASSWORD: actual-value
 *   NODE_ENV: production                →  NODE_ENV: production
 */
/**
 * Resolve $env:VAR_NAME references in a compose YAML string.
 * Plain values pass through unchanged. Only $env: prefixed values
 * are resolved from process.env.
 *
 *   DATABASE_PASSWORD: $env:MY_DB_PASS  →  DATABASE_PASSWORD: actual-value
 *   NODE_ENV: production                →  NODE_ENV: production
 */
export function resolveComposeEnvRefs(yaml: string): string {
  if (!yaml) return yaml;

  // Key-value form:  KEY: $env:VAR_NAME
  const resolved = yaml.replace(
    /^(\s+[A-Z_][A-Z0-9_]*:\s*)\$env:([A-Z_][A-Z0-9_]*)$/gm,
    (match, prefix: string, varName: string) => {
      const value = process.env[varName];
      if (!value) {
        throw new Error(
          `$env:${varName} referenced in compose but not set in environment`
        );
      }
      return `${prefix}${value}`;
    }
  );

  // List form:  - KEY=$env:VAR_NAME
  return resolved.replace(
    /^(\s+-\s+[A-Z_][A-Z0-9_]*=)\$env:([A-Z_][A-Z0-9_]*)$/gm,
    (match, prefix: string, varName: string) => {
      const value = process.env[varName];
      if (!value) {
        throw new Error(
          `$env:${varName} referenced in compose but not set in environment`
        );
      }
      return `${prefix}${value}`;
    }
  );
}

const PLACEHOLDER = "[REDACTED]";
const LIST_PLACEHOLDER = /^([A-Za-z_][A-Za-z0-9_.-]*)=\[REDACTED\]$/;

type Path = (string | number)[];

export interface ComposeRestore {
  yaml: string;
  /** dotted paths restored, with the index of the source that supplied each */
  restored: { path: string; source: number }[];
  /** paths where a later source disagreed with the one used */
  stale: string[];
  /** placeholders no source could fill; the caller must not write these */
  unresolved: string[];
}

// `KEY: [REDACTED]` parses as a one-item flow sequence, quoted forms as a string
function isPlaceholderNode(node: unknown): boolean {
  if (isScalar(node)) return node.value === PLACEHOLDER;
  if (isSeq(node) && node.flow && node.items.length === 1) {
    const item = node.items[0];
    return isScalar(item) && item.value === "REDACTED";
  }
  return false;
}

function getIn(obj: unknown, path: Path): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Compose env is either `KEY: value` or `- KEY=value`; look a key up in either. */
function envValue(env: unknown, key: string): unknown {
  if (Array.isArray(env)) {
    for (const e of env) if (typeof e === "string" && e.startsWith(`${key}=`)) return e.slice(key.length + 1);
    return undefined;
  }
  if (env && typeof env === "object") return (env as Record<string, unknown>)[key];
  return undefined;
}

function usable(v: unknown): v is string | number | boolean {
  return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !String(v).includes(PLACEHOLDER);
}

function lookup(src: unknown, path: Path, key: string, listForm: boolean): unknown {
  // service env: match by name within the same service, whichever form either side uses
  if (path[0] === "services" && path[2] === "environment" && path.length === 4) {
    return envValue(getIn(src, ["services", path[1], "environment"]), key);
  }
  if (!listForm) return getIn(src, path);
  return envValue(getIn(src, path.slice(0, -1)), key);
}

function parseSource(yaml: string): unknown {
  if (!yaml) return undefined;
  try {
    return parse(yaml, { merge: true, prettyErrors: false, logLevel: "error" });
  } catch {
    return undefined;
  }
}

/**
 * Restore [REDACTED] placeholders in an edited compose from the original
 * composes, structurally rather than by line:
 *
 * 1. get_stack returns compose with sensitive values as [REDACTED]
 * 2. the model edits what it needs and leaves [REDACTED] in place, quoted or not
 * 3. each placeholder is filled from the same service + key (or the same path
 *    outside services) in the first source that has a real value
 *
 * Anything no source can fill is reported in `unresolved`; writing it would
 * ship the literal placeholder, so callers must refuse.
 */
export function restoreComposeRedactions(edited: string, sources: string[]): ComposeRestore {
  const result: ComposeRestore = { yaml: edited, restored: [], stale: [], unresolved: [] };
  if (!edited || !edited.includes("REDACTED")) return result;

  const doc = parseDocument(edited, { merge: true, prettyErrors: false, logLevel: "error" });
  if (doc.errors.length) throw new Error(`compose is not valid YAML (${doc.errors[0].code})`);
  const parsed = sources.map(parseSource);

  const found: { path: Path; key: string; listForm: boolean; set: (v: string | number | boolean) => void }[] = [];
  const walk = (node: unknown, path: Path): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? pair.key.value : pair.key;
        if (typeof k !== "string" && typeof k !== "number") continue;
        const p = [...path, k];
        if (isPlaceholderNode(pair.value)) {
          found.push({ path: p, key: String(k), listForm: false, set: (v) => { pair.value = doc.createNode(v); } });
        } else {
          walk(pair.value, p);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const p = [...path, i];
        if (isScalar(item) && typeof item.value === "string") {
          const m = LIST_PLACEHOLDER.exec(item.value);
          if (m) {
            found.push({ path: p, key: m[1], listForm: true, set: (v) => { item.value = `${m[1]}=${v}`; } });
            return;
          }
        }
        walk(item, p);
      });
    }
  };
  walk(doc.contents, []);

  for (const f of found) {
    const where = f.listForm ? [...f.path.slice(0, -1), f.key].join(".") : f.path.join(".");
    const values = parsed.map((src) => lookup(src, f.path, f.key, f.listForm));
    const first = values.findIndex(usable);
    if (first === -1) {
      result.unresolved.push(where);
      continue;
    }
    const value = values[first] as string | number | boolean;
    f.set(value);
    result.restored.push({ path: where, source: first });
    if (values.slice(first + 1).some((v) => usable(v) && String(v) !== String(value))) result.stale.push(where);
  }

  if (found.length) result.yaml = doc.toString({ lineWidth: 0 });
  return result;
}

/** Single-source restore; unresolved placeholders are left as-is. */
export function restoreRedactedValues(editedYaml: string, originalYaml: string): string {
  return restoreComposeRedactions(editedYaml, [originalYaml]).yaml;
}
