export type RedactMode = "all" | "sensitive" | "none";

export interface SwarmpitConfig {
  url: string;
  token: string;
  redact: RedactMode;
  redactPatterns: string[];
}

export function loadConfig(): SwarmpitConfig {
  const url = process.env.SWARMPIT_URL;
  const token = process.env.SWARMPIT_TOKEN;

  if (!url) throw new Error("SWARMPIT_URL is not set");
  if (!token) throw new Error("SWARMPIT_TOKEN is not set");

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
