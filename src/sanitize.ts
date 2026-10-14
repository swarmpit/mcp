import { isAlias, isMap, isNode, isScalar, isSeq, Scalar, type Pair } from "yaml";
import { parseComposeDocument, walkYaml } from "./compose-yaml.js";
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

export function sanitizeComposeYaml(yaml: string, redactAll = true): string {
  if (!yaml) return yaml;
  const doc = parseComposeDocument(yaml);
  const shouldRedact = (name: string) => redactAll || isSensitiveEnvVar(name);
  const resolve = (node: unknown): unknown => isAlias(node) ? node.resolve(doc) : node;
  const redactions = new Map<Scalar, string>();
  const mappingKeys = new Set<unknown>();
  const envUses = new Map<Scalar, { value: string; apply: () => void }[]>();
  const recordEnvUse = (target: Scalar, source: unknown, value: string, set: (copy: Scalar) => void): void => {
    const uses = envUses.get(target) ?? [];
    uses.push({ value, apply: () => {
      const copy = doc.createNode(value);
      if (isScalar(source)) copy.anchor = source.anchor;
      set(copy);
    } });
    envUses.set(target, uses);
  };
  const forEachMapping = (node: unknown, visit: (pair: Pair) => void, visited = new Set<unknown>()): void => {
    const target = resolve(node);
    if (visited.has(target)) return;
    visited.add(target);
    if (isSeq(target)) {
      for (const item of target.items) forEachMapping(item, visit, visited);
    } else if (isMap(target)) {
      for (const pair of target.items) {
        const key = resolve(pair.key);
        if (isScalar(key) && (key.value === "<<" || key.source === "<<")) {
          forEachMapping(pair.value, visit, visited);
        } else {
          visit(pair);
        }
      }
    }
  };
  const redactValue = (node: unknown): void => {
    const target = resolve(node);
    if (isScalar(target) && target.value !== null && target.value !== undefined) {
      redactions.set(target, PLACEHOLDER);
    } else if (target && !isScalar(target) && !isPlaceholderNode(target)) {
      throw new Error("compose environment values must be scalars");
    }
  };
  const seen = new Set<unknown>();
  const redactEnvironment = (node: unknown): void => {
    const target = resolve(node);
    if (seen.has(target)) return;
    seen.add(target);
    if (isMap(target)) {
      for (const pair of target.items) {
        const key = resolve(pair.key);
        if (!isScalar(key)) throw new Error("compose environment names must be scalar keys");
        if (key.value === "<<" || key.source === "<<") {
          redactEnvironment(pair.value);
        } else {
          if (shouldRedact(String(key.value))) redactValue(pair.value);
          const value = resolve(pair.value);
          if (isScalar(value) && value.value !== null && value.value !== undefined) {
            recordEnvUse(value, pair.value, PLACEHOLDER, (copy) => { pair.value = copy; });
          }
        }
      }
    } else if (isSeq(target)) {
      for (const [i, item] of target.items.entries()) {
        const value = resolve(item);
        if (isMap(value) || isSeq(value)) {
          redactEnvironment(value);
        } else if (isScalar(value) && typeof value.value === "string") {
          const match = /^([^=]+)=(.*)$/s.exec(value.value);
          if (match) {
            const replacement = `${match[1]}=${PLACEHOLDER}`;
            if (shouldRedact(match[1]) && !redactions.has(value)) redactions.set(value, replacement);
            recordEnvUse(value, item, replacement, (copy) => { target.items[i] = copy; });
          }
        } else {
          throw new Error("compose environment list entries must be strings");
        }
      }
    } else if (target && !(isScalar(target) && target.value === null)) {
      throw new Error("compose environment must be a map or list");
    }
  };

  const serviceField = (pair: Pair): void => {
    const key = resolve(pair.key);
    if (isScalar(key) && key.value === "environment") redactEnvironment(pair.value);
  };
  forEachMapping(doc.contents, (pair) => {
    const key = resolve(pair.key);
    if (!isScalar(key) || typeof key.value !== "string") return;
    if (key.value === "services") {
      forEachMapping(pair.value, (service) => forEachMapping(service.value, serviceField));
    } else if (key.value.startsWith("x-")) {
      forEachMapping(pair.value, (field) => {
        const value = resolve(field.value);
        if (isMap(value) || isSeq(value)) serviceField(field);
      });
    } else if (key.value === "environment") {
      serviceField(pair);
    }
  });

  walkYaml(doc.contents, (node) => {
    if (isNode(node)) {
      node.comment = undefined;
      node.commentBefore = undefined;
    }
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const keyNode = resolve(pair.key);
      mappingKeys.add(keyNode);
      if (!isScalar(keyNode) || typeof keyNode.value !== "string") continue;
      const key = keyNode.value;
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && shouldRedact(key) && isScalar(resolve(pair.value))) {
        redactValue(pair.value);
      }
    }
  });
  // classify every alias before changing scalars that may also name fields.
  for (const [node, value] of redactions) {
    if (mappingKeys.has(node)) throw new Error("compose cannot redact an anchor shared with a mapping key");
    node.value = value;
    if (value === PLACEHOLDER) node.type = Scalar.QUOTE_DOUBLE;
  }
  // one anchor may be a whole map value and a NAME=value list entry.
  for (const [node, uses] of envUses) {
    if (redactions.has(node) && uses.some(({ value }) => value !== redactions.get(node))) {
      for (const use of uses) use.apply();
    }
  }
  doc.comment = null;
  doc.commentBefore = null;
  return doc.toString({ lineWidth: 0 });
}

export function resolveComposeEnvRefs(yaml: string): string {
  const reference = /(?<!\$)(?:\$\$)*\$env:/;
  if (!reference.test(yaml)) return yaml;
  const doc = parseComposeDocument(yaml);
  let changed = false;
  walkYaml(doc.contents, (node, key) => {
    if (!isScalar(node) || typeof node.value !== "string" || !reference.test(node.value)) return;
    const match = /^(?:([A-Za-z_][A-Za-z0-9_.-]*=))?\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(node.value);
    if (key || !match) throw new Error("Unsupported $env reference: use a complete value or KEY=$env:VAR_NAME");
    const value = process.env[match[2]];
    if (value === undefined) throw new Error(`$env:${match[2]} referenced in compose but not set in environment`);
    // locally resolved credentials must not be interpolated again by Docker.
    node.value = `${match[1] ?? ""}${value.replace(/\$/g, () => "$$")}`;
    node.type = Scalar.QUOTE_DOUBLE;
    changed = true;
  });
  return changed ? doc.toString({ lineWidth: 0 }) : yaml;
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
    if (!Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Compose env is either `KEY: value` or `- KEY=value`; look a key up in either. */
function envValue(env: unknown, key: string): unknown {
  if (Array.isArray(env)) {
    for (let i = env.length - 1; i >= 0; i--) {
      const entry = env[i];
      if (typeof entry === "string" && entry.startsWith(`${key}=`)) return entry.slice(key.length + 1);
    }
    return undefined;
  }
  if (env && typeof env === "object" && Object.hasOwn(env, key)) return (env as Record<string, unknown>)[key];
  return undefined;
}

function usable(v: unknown): v is string | number | boolean {
  return (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !String(v).includes(PLACEHOLDER);
}

function isServiceEnvironment(path: Path): boolean {
  return path[0] === "services" && path[2] === "environment" && path.length === 4;
}

function matchesRestorationShape(edited: unknown, source: unknown): boolean {
  if (edited === PLACEHOLDER) return usable(source);
  if (typeof edited === "string") {
    const match = LIST_PLACEHOLDER.exec(edited);
    if (match) return typeof source === "string" && source.startsWith(`${match[1]}=`) && usable(source);
  }
  if (Array.isArray(edited)) {
    return Array.isArray(source) && edited.length === source.length
      && edited.every((value, i) => matchesRestorationShape(value, source[i]));
  }
  if (edited && source && typeof edited === "object" && typeof source === "object" && !Array.isArray(source)) {
    const keys = Object.keys(edited);
    return keys.length === Object.keys(source).length && keys.every((key) =>
      Object.hasOwn(source, key) && matchesRestorationShape(
        (edited as Record<string, unknown>)[key], (source as Record<string, unknown>)[key]
      )
    );
  }
  return Object.is(edited, source);
}

function hasStableListContext(edited: unknown, sources: unknown[], path: Path, listForm: boolean): boolean {
  if (isServiceEnvironment(path) || (path.length === 1 && listForm)) return true;
  return path.every((key, i) => {
    if (typeof key !== "number") return true;
    const parent = path.slice(0, i);
    const source = sources.map((candidate) => getIn(candidate, parent)).find((value) => value !== undefined);
    return matchesRestorationShape(getIn(edited, parent), source);
  });
}

function lookup(src: unknown, path: Path, key: string, listForm: boolean): unknown {
  // service env: match by name within the same service, whichever form either side uses
  if (isServiceEnvironment(path)) {
    return envValue(getIn(src, ["services", path[1], "environment"]), key);
  }
  if (!listForm) return getIn(src, path);
  const value = getIn(src, path);
  if (typeof value === "string" && value.startsWith(`${key}=`)) return value.slice(key.length + 1);
  return envValue(getIn(src, path.slice(0, -1)), key);
}

function parseSource(yaml: string): unknown {
  if (!yaml) return undefined;
  return parseComposeDocument(yaml).toJS({ maxAliasCount: 100 });
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

  const doc = parseComposeDocument(edited);
  const normalizePlaceholder = (node: unknown) => {
    if (!isSeq(node) || !isPlaceholderNode(node)) return undefined;
    const replacement = doc.createNode(PLACEHOLDER);
    replacement.anchor = node.anchor;
    return replacement;
  };
  walkYaml(doc.contents, (node) => {
    if (isMap(node)) {
      for (const pair of node.items) pair.value = normalizePlaceholder(pair.value) ?? pair.value;
    } else if (isSeq(node)) {
      node.items = node.items.map((item) => normalizePlaceholder(item) ?? item);
    }
  });
  // each service must restore its own live value, even when the input shares an anchor.
  doc.contents = doc.createNode(doc.toJS({ maxAliasCount: 100 }), { aliasDuplicateObjects: false });
  let removedTemplate = false;
  if (isMap(doc.contents)) {
    for (const pair of [...doc.contents.items]) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !pair.key.value.startsWith("x-")) continue;
      let redacted = false;
      walkYaml(pair.value, (node) => {
        if (isScalar(node) && typeof node.value === "string" && node.value.includes(PLACEHOLDER)) redacted = true;
      });
      // consumers are now inline; retaining an unused template can retain an obsolete credential.
      if (redacted) {
        doc.delete(pair.key.value);
        removedTemplate = true;
      }
    }
  }
  const parsed = sources.map(parseSource);
  const editedSpec = doc.toJS({ maxAliasCount: 100 });

  const found: { path: Path; key: string; listForm: boolean; set: (v: string | number | boolean) => void }[] = [];
  const walk = (node: unknown, path: Path): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? pair.key.value : pair.key;
        if (typeof k !== "string" && typeof k !== "number") continue;
        const p = [...path, k];
        if (isPlaceholderNode(pair.value)) {
          found.push({ path: p, key: String(k), listForm: false, set: (v) => { pair.value = doc.createNode(v); } });
        } else if (isScalar(pair.value) && typeof pair.value.value === "string" && LIST_PLACEHOLDER.test(pair.value.value)) {
          const name = LIST_PLACEHOLDER.exec(pair.value.value)![1];
          found.push({ path: p, key: name, listForm: true, set: (v) => { pair.value = doc.createNode(`${name}=${v}`); } });
        } else {
          walk(pair.value, p);
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const p = [...path, i];
        if (isPlaceholderNode(item)) {
          found.push({ path: p, key: String(i), listForm: false, set: (v) => { node.items[i] = doc.createNode(v); } });
          return;
        }
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
    if (!hasStableListContext(editedSpec, parsed, f.path, f.listForm)) {
      result.unresolved.push(where);
      continue;
    }
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

  if (found.length || removedTemplate) result.yaml = doc.toString({ lineWidth: 0 });
  return result;
}

/** Single-source restore; unresolved placeholders are left as-is. */
export function restoreRedactedValues(editedYaml: string, originalYaml: string): string {
  return restoreComposeRedactions(editedYaml, [originalYaml]).yaml;
}
