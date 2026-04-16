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

function isSensitiveEnvVar(name: string): boolean {
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
  return sanitized.replace(
    /^(\s+-\s+)([A-Z_][A-Z0-9_]*)=(.+)$/gm,
    (match, prefix: string, key: string, value: string) => {
      if (redactAll || isSensitiveEnvVar(key)) {
        return `${prefix}${key}=[REDACTED]`;
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

/**
 * Build env var lookup from raw compose YAML. Extracts KEY=value pairs
 * so [REDACTED] values can be restored from the original.
 */
function extractComposeEnvVars(yaml: string): Map<string, string> {
  const vars = new Map<string, string>();
  if (!yaml) return vars;

  // Key-value form:  KEY: value
  for (const match of yaml.matchAll(
    /^\s+([A-Z_][A-Z0-9_]*):\s*(.+)$/gm
  )) {
    vars.set(match[1], match[2]);
  }

  // List form:  - KEY=value
  for (const match of yaml.matchAll(
    /^\s+-\s+([A-Z_][A-Z0-9_]*)=(.+)$/gm
  )) {
    vars.set(match[1], match[2]);
  }

  return vars;
}

/**
 * Restore [REDACTED] values in an edited compose YAML from the original
 * raw compose. This allows safe round-tripping:
 *
 * 1. swarmpit_get_stack returns compose with sensitive values as [REDACTED]
 * 2. Claude edits only what it needs, leaves [REDACTED] in place
 * 3. This function restores original values where [REDACTED] remains
 * 4. $env:VAR references are resolved from process.env
 * 5. Plaintext values pass through as-is
 */
export function restoreRedactedValues(
  editedYaml: string,
  originalYaml: string
): string {
  if (!editedYaml) return editedYaml;

  const origVars = extractComposeEnvVars(originalYaml);

  // Key-value form: restore KEY: [REDACTED]
  let restored = editedYaml.replace(
    /^(\s+)([A-Z_][A-Z0-9_]*):\s*\[REDACTED\]$/gm,
    (match, indent: string, key: string) => {
      const original = origVars.get(key);
      if (original) {
        return `${indent}${key}: ${original}`;
      }
      return match;
    }
  );

  // List form: restore - KEY=[REDACTED]
  restored = restored.replace(
    /^(\s+-\s+)([A-Z_][A-Z0-9_]*)=\[REDACTED\]$/gm,
    (match, prefix: string, key: string) => {
      const original = origVars.get(key);
      if (original) {
        return `${prefix}${key}=${original}`;
      }
      return match;
    }
  );

  return restored;
}
