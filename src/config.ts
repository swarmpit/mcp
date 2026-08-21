import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type RedactMode = "all" | "sensitive" | "none";

export interface SwarmpitServerConfig {
  name: string;
  url: string;
  token: string;
}

export interface SwarmpitConfig {
  servers: SwarmpitServerConfig[];
  /** Server used when a tool call omits `server`. Undefined means the caller must name one. */
  defaultServer?: string;
  redact: RedactMode;
  redactPatterns: string[];
  /** URL of the default server. Present whenever a default resolves. */
  url?: string;
  /** Token of the default server. Present whenever a default resolves. */
  token?: string;
}

export const LEGACY_SERVER_NAME = "default";

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function readTokenFile(path: string, label: string): string {
  try {
    return readFileSync(expandHome(path), "utf-8").trim();
  } catch (err) {
    throw new Error(
      `${label} "${path}" could not be read: ${err instanceof Error ? err.message : err}`
    );
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Env var infix for a server name: "swarmpit-play" → SWARMPIT_SWARMPIT_PLAY_URL */
function envKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function loadRedact(): RedactMode {
  const raw = process.env.SWARMPIT_REDACT;
  if (raw === undefined) return "all";
  if (raw !== "all" && raw !== "sensitive" && raw !== "none") {
    throw new Error('SWARMPIT_REDACT must be "all" (default), "sensitive", or "none"');
  }
  return raw;
}

interface ConfigFileServer {
  url?: string;
  token?: string;
  tokenFile?: string;
}

interface ServerSet {
  servers: SwarmpitServerConfig[];
  defaultServer?: string;
}

function loadFromConfigFile(path: string): ServerSet {
  let parsed: { servers?: Record<string, ConfigFileServer>; default?: string };
  try {
    parsed = JSON.parse(readFileSync(expandHome(path), "utf-8"));
  } catch (err) {
    throw new Error(
      `SWARMPIT_CONFIG_FILE "${path}" could not be read: ${err instanceof Error ? err.message : err}`
    );
  }

  const entries = Object.entries(parsed.servers ?? {});
  if (entries.length === 0) {
    throw new Error(`SWARMPIT_CONFIG_FILE "${path}" defines no servers`);
  }

  const servers = entries.map(([name, spec]) => {
    if (!spec?.url) throw new Error(`Server "${name}" in ${path} has no url`);
    const token = spec.tokenFile
      ? readTokenFile(spec.tokenFile, `tokenFile for server "${name}"`)
      : spec.token;
    if (!token) {
      throw new Error(
        `Server "${name}" in ${path} has neither token nor tokenFile. Prefer tokenFile to keep the token out of the config file.`
      );
    }
    return { name, url: normalizeUrl(spec.url), token };
  });

  if (parsed.default && !servers.some((s) => s.name === parsed.default)) {
    throw new Error(
      `default server "${parsed.default}" in ${path} is not one of: ${servers.map((s) => s.name).join(", ")}`
    );
  }

  return { servers, defaultServer: parsed.default };
}

function loadFromServerList(list: string): ServerSet {
  const names = list.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error("SWARMPIT_SERVERS is set but lists no server names");

  const servers = names.map((name) => {
    const key = envKey(name);
    const url = process.env[`SWARMPIT_${key}_URL`];
    if (!url) {
      throw new Error(`SWARMPIT_${key}_URL is not set (required by SWARMPIT_SERVERS="${list}")`);
    }
    const tokenFile = process.env[`SWARMPIT_${key}_TOKEN_FILE`];
    const token = tokenFile
      ? readTokenFile(tokenFile, `SWARMPIT_${key}_TOKEN_FILE`)
      : process.env[`SWARMPIT_${key}_TOKEN`];
    if (!token) {
      throw new Error(
        `Neither SWARMPIT_${key}_TOKEN nor SWARMPIT_${key}_TOKEN_FILE is set. Use the _TOKEN_FILE form to avoid storing the token in MCP client config files.`
      );
    }
    return { name, url: normalizeUrl(url), token };
  });

  const defaultServer = process.env.SWARMPIT_DEFAULT_SERVER;
  if (defaultServer && !servers.some((s) => s.name === defaultServer)) {
    throw new Error(`SWARMPIT_DEFAULT_SERVER="${defaultServer}" is not one of: ${names.join(", ")}`);
  }

  return { servers, defaultServer };
}

function loadLegacySingleServer(): ServerSet {
  const url = process.env.SWARMPIT_URL;
  if (!url) throw new Error("SWARMPIT_URL is not set");

  const tokenFile = process.env.SWARMPIT_TOKEN_FILE;
  const token = tokenFile
    ? readTokenFile(tokenFile, "SWARMPIT_TOKEN_FILE")
    : process.env.SWARMPIT_TOKEN;
  if (!token) {
    throw new Error(
      "Neither SWARMPIT_TOKEN nor SWARMPIT_TOKEN_FILE is set. Use SWARMPIT_TOKEN_FILE to avoid storing the token in MCP client config files."
    );
  }

  return {
    servers: [{ name: LEGACY_SERVER_NAME, url: normalizeUrl(url), token }],
    defaultServer: LEGACY_SERVER_NAME,
  };
}

export function loadConfig(): SwarmpitConfig {
  const configFile = process.env.SWARMPIT_CONFIG_FILE;
  const serverList = process.env.SWARMPIT_SERVERS;

  const { servers, defaultServer } = configFile
    ? loadFromConfigFile(configFile)
    : serverList
      ? loadFromServerList(serverList)
      : loadLegacySingleServer();

  const names = servers.map((s) => s.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`Duplicate server name "${duplicate}"`);

  // One server needs no disambiguation. With several, a tool call may omit
  // `server` only if an explicit default was configured — otherwise a forgotten
  // argument would silently pick a cluster for you.
  const resolvedDefault = servers.length === 1 ? servers[0].name : defaultServer;
  const def = servers.find((s) => s.name === resolvedDefault);

  const redactPatterns = process.env.SWARMPIT_REDACT_PATTERNS
    ? process.env.SWARMPIT_REDACT_PATTERNS.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  return {
    servers,
    defaultServer: resolvedDefault,
    redact: loadRedact(),
    redactPatterns,
    url: def?.url,
    token: def?.token,
  };
}
