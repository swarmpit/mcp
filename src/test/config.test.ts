import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Clear all SWARMPIT_ vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SWARMPIT_")) delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SWARMPIT_")) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });

  it("loads config from env vars", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN = "test-token";

    const config = loadConfig();
    assert.equal(config.url, "https://swarmpit.example.com");
    assert.equal(config.token, "test-token");
    assert.equal(config.redact, "all");
  });

  it("strips trailing slashes from URL", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com///";
    process.env.SWARMPIT_TOKEN = "test-token";

    const config = loadConfig();
    assert.equal(config.url, "https://swarmpit.example.com");
  });

  it("reads SWARMPIT_REDACT mode", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN = "test-token";
    process.env.SWARMPIT_REDACT = "sensitive";

    const config = loadConfig();
    assert.equal(config.redact, "sensitive");
  });

  it("accepts none redact mode", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN = "test-token";
    process.env.SWARMPIT_REDACT = "none";

    const config = loadConfig();
    assert.equal(config.redact, "none");
  });

  it("throws on missing SWARMPIT_URL", () => {
    process.env.SWARMPIT_TOKEN = "test-token";
    assert.throws(() => loadConfig(), /SWARMPIT_URL is not set/);
  });

  it("throws on missing SWARMPIT_TOKEN", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    assert.throws(
      () => loadConfig(),
      /Neither SWARMPIT_TOKEN nor SWARMPIT_TOKEN_FILE is set/
    );
  });

  it("loads token from SWARMPIT_TOKEN_FILE", async () => {
    const { writeFileSync, unlinkSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mcp-token-"));
    const path = join(dir, "token");
    writeFileSync(path, "file-loaded-token\n"); // trailing newline should be stripped
    try {
      process.env.SWARMPIT_URL = "https://swarmpit.example.com";
      process.env.SWARMPIT_TOKEN_FILE = path;
      const config = loadConfig();
      assert.equal(config.token, "file-loaded-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SWARMPIT_TOKEN_FILE takes precedence over SWARMPIT_TOKEN", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mcp-token-"));
    const path = join(dir, "token");
    writeFileSync(path, "from-file");
    try {
      process.env.SWARMPIT_URL = "https://swarmpit.example.com";
      process.env.SWARMPIT_TOKEN = "from-env";
      process.env.SWARMPIT_TOKEN_FILE = path;
      assert.equal(loadConfig().token, "from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when SWARMPIT_TOKEN_FILE points to missing file", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN_FILE = "/nonexistent/token-file";
    assert.throws(() => loadConfig(), /could not be read/);
  });

  it("throws on invalid SWARMPIT_REDACT", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN = "test-token";
    process.env.SWARMPIT_REDACT = "invalid";
    assert.throws(() => loadConfig(), /SWARMPIT_REDACT/);
  });
});
