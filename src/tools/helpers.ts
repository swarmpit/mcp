import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function toolResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function toolError(error: unknown): CallToolResult {
  const message =
    error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Prepare a service object from GET response for use in POST update.
 * - Strips null values (API rejects them for optional fields)
 * - Strips read-only fields not accepted by the edit endpoint
 * - Trims repository to { name, tag } (API rejects imageDigest/image)
 * - Normalises nested nulls the backend spec rejects even though its own
 *   GET emits them (deployment.maxReplicas, mounts[].volumeOptions[.driver.options])
 */
export function prepareServiceForUpdate(service: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const readOnlyKeys = new Set(["id", "createdAt", "updatedAt", "state", "status"]);

  for (const [key, value] of Object.entries(service)) {
    if (value === null || readOnlyKeys.has(key)) continue;
    result[key] = value;
  }

  // Repository: API only accepts { name, tag }
  const repo = service.repository as Record<string, unknown> | undefined;
  if (repo) {
    result.repository = { name: repo.name, tag: repo.tag };
  }

  const deployment = result.deployment as Record<string, unknown> | undefined;
  if (deployment && deployment.maxReplicas === null) {
    result.deployment = { ...deployment, maxReplicas: 0 };
  }

  if (Array.isArray(result.mounts)) {
    result.mounts = result.mounts.map((mount) => normalizeMount(mount));
  }

  return result;
}

function normalizeMount(mount: unknown): unknown {
  if (!mount || typeof mount !== "object") return mount;
  const m = { ...(mount as Record<string, unknown>) };

  // Bind mounts come back with volumeOptions: null; the spec wants a map or nothing.
  if (m.volumeOptions === null) {
    delete m.volumeOptions;
    return m;
  }
  if (m.volumeOptions && typeof m.volumeOptions === "object") {
    const vo = { ...(m.volumeOptions as Record<string, unknown>) };
    const driver = vo.driver as Record<string, unknown> | null | undefined;
    if (driver && typeof driver === "object" && driver.options === null) {
      vo.driver = { ...driver, options: {} };
    }
    m.volumeOptions = vo;
  }
  return m;
}

/**
 * Restore env vars whose value is the literal "[REDACTED]" from the live
 * service, so a get_service → edit → update_service round-trip can't
 * overwrite real secrets with the redaction placeholder.
 */
export function restoreRedactedVariables(
  incoming: unknown,
  live: { name: string; value: string }[] | undefined
): { variables: unknown; restored: string[] } {
  if (!Array.isArray(incoming)) return { variables: incoming, restored: [] };

  const liveByName = new Map((live ?? []).map((v) => [v.name, v.value]));
  const restored: string[] = [];

  const variables = incoming.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const v = entry as Record<string, unknown>;
    if (v.value !== "[REDACTED]" || typeof v.name !== "string") return entry;
    const original = liveByName.get(v.name);
    if (original === undefined) return entry;
    restored.push(v.name);
    return { ...v, value: original };
  });

  return { variables, restored };
}

export function resolveEnvRef(
  value: unknown
): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "$env" in value &&
    typeof (value as Record<string, unknown>).$env === "string"
  ) {
    const varName = (value as Record<string, string>).$env;
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(
        `$env reference "${varName}" is not set in environment`
      );
    }
    return resolved;
  }
  throw new Error(
    `Invalid env var value: expected a string or { "$env": "VAR_NAME" }`
  );
}

/**
 * Compare the spec about to be written against the live one, without ever
 * putting an env var value in the result — the point of a preview is to say
 * what would change, not to leak the values redaction just hid.
 */
export function previewServiceChanges(
  live: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const skip = new Set(["variables", "id", "createdAt", "updatedAt", "state", "status", "version"]);
  const fields: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of new Set([...Object.keys(live), ...Object.keys(next)])) {
    if (skip.has(key)) continue;
    const before = live[key];
    const after = next[key];
    if (after === undefined) continue;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fields[key] = { from: before ?? null, to: after };
    }
  }

  const liveVars = new Map(
    ((live.variables as { name: string; value: string }[]) ?? []).map((v) => [v.name, v.value])
  );
  const nextVars = new Map(
    ((next.variables as { name: string; value: string }[]) ?? []).map((v) => [v.name, v.value])
  );

  const added: string[] = [];
  const changed: string[] = [];
  for (const [name, value] of nextVars) {
    if (!liveVars.has(name)) added.push(name);
    else if (liveVars.get(name) !== value) changed.push(name);
  }
  const removed = [...liveVars.keys()].filter((n) => !nextVars.has(n));

  const variables: Record<string, unknown> = { unchanged: nextVars.size - added.length - changed.length };
  if (added.length) variables.added = added;
  if (changed.length) variables.changed = changed;
  if (removed.length) variables.removed = removed;

  return { fields, variables };
}

/**
 * Line-level diff of two compose documents. Both sides are expected to be
 * sanitized already, so secret values never appear in the output.
 */
export function previewComposeChanges(
  before: string,
  after: string
): Record<string, unknown> {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  const removed = beforeLines.filter((l) => l.trim() && !afterSet.has(l));
  const added = afterLines.filter((l) => l.trim() && !beforeSet.has(l));

  return {
    changed: removed.length > 0 || added.length > 0,
    ...(removed.length ? { removed } : {}),
    ...(added.length ? { added } : {}),
  };
}

/**
 * Resolve a data value that may be a plain string, { $file: path }, or { $env: var }.
 * Used for config/secret data to avoid sending large payloads through the LLM context.
 */
export function resolveData(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if ("$file" in value && typeof (value as Record<string, unknown>).$file === "string") {
      const path = (value as Record<string, string>).$file;
      try {
        return readFileSync(path, "utf-8");
      } catch (err) {
        throw new Error(
          `$file reference "${path}" could not be read: ${err instanceof Error ? err.message : err}`
        );
      }
    }
    if ("$env" in value && typeof (value as Record<string, unknown>).$env === "string") {
      return resolveEnvRef(value);
    }
  }
  throw new Error(
    'Invalid data: expected a string, { "$file": "/path" }, or { "$env": "VAR_NAME" }'
  );
}
