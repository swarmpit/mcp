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

/** Strip null values from an object — Swarmpit API rejects nulls for optional fields */
export function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) {
      result[key] = value;
    }
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
