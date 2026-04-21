import { readFileSync } from "node:fs";

export type RedactMode = "all" | "sensitive" | "none";

export interface SwarmpitConfig {
  url: string;
  token: string;
  redact: RedactMode;
  redactPatterns: string[];
}

function loadToken(): string {
  const tokenFile = process.env.SWARMPIT_TOKEN_FILE;
  if (tokenFile) {
    try {
      return readFileSync(tokenFile, "utf-8").trim();
    } catch (err) {
      throw new Error(
        `SWARMPIT_TOKEN_FILE "${tokenFile}" could not be read: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  const token = process.env.SWARMPIT_TOKEN;
  if (!token) {
    throw new Error(
      "Neither SWARMPIT_TOKEN nor SWARMPIT_TOKEN_FILE is set. Use SWARMPIT_TOKEN_FILE to avoid storing the token in MCP client config files."
    );
  }
  return token;
}

export function loadConfig(): SwarmpitConfig {
  const url = process.env.SWARMPIT_URL;
  if (!url) throw new Error("SWARMPIT_URL is not set");

  const token = loadToken();

  const redactRaw = process.env.SWARMPIT_REDACT;
  let redact: RedactMode = "all";
  if (redactRaw !== undefined) {
    if (redactRaw !== "all" && redactRaw !== "sensitive" && redactRaw !== "none") {
      throw new Error('SWARMPIT_REDACT must be "all" (default), "sensitive", or "none"');
    }
    redact = redactRaw;
  }

  const redactPatterns = process.env.SWARMPIT_REDACT_PATTERNS
    ? process.env.SWARMPIT_REDACT_PATTERNS.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  return {
    url: url.replace(/\/+$/, ""),
    token,
    redact,
    redactPatterns,
  };
}
