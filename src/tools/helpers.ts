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

  return result;
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
