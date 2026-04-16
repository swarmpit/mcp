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
    assert.throws(() => loadConfig(), /SWARMPIT_TOKEN is not set/);
  });

  it("throws on invalid SWARMPIT_REDACT", () => {
    process.env.SWARMPIT_URL = "https://swarmpit.example.com";
    process.env.SWARMPIT_TOKEN = "test-token";
    process.env.SWARMPIT_REDACT = "invalid";
    assert.throws(() => loadConfig(), /SWARMPIT_REDACT/);
  });
});
