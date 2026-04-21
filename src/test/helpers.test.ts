import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolResult, toolError, resolveEnvRef, prepareServiceForUpdate, resolveData } from "../tools/helpers.js";
import { writeFileSync, unlinkSync } from "node:fs";

describe("toolResult", () => {
  it("wraps data as JSON text content", () => {
    const result = toolResult({ foo: "bar" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { foo: "bar" });
  });
});

describe("toolError", () => {
  it("wraps Error as text with isError flag", () => {
    const result = toolError(new Error("something broke"));
    assert.equal(result.isError, true);
    assert.equal((result.content[0] as { text: string }).text, "something broke");
  });

  it("wraps string as text with isError flag", () => {
    const result = toolError("plain string error");
    assert.equal(result.isError, true);
    assert.equal((result.content[0] as { text: string }).text, "plain string error");
  });
});

describe("resolveEnvRef", () => {
  it("returns plain strings as-is", () => {
    assert.equal(resolveEnvRef("hello"), "hello");
  });

  it("resolves { $env: VAR } from process.env", () => {
    process.env.TEST_RESOLVE_VAR = "resolved-value";
    assert.equal(resolveEnvRef({ $env: "TEST_RESOLVE_VAR" }), "resolved-value");
    delete process.env.TEST_RESOLVE_VAR;
  });

  it("throws on missing env var ref", () => {
    delete process.env.NONEXISTENT_REF;
    assert.throws(() => resolveEnvRef({ $env: "NONEXISTENT_REF" }), /NONEXISTENT_REF/);
  });

  it("throws on invalid value type", () => {
    assert.throws(() => resolveEnvRef(42), /Invalid env var value/);
  });
});

describe("prepareServiceForUpdate", () => {
  it("strips null values", () => {
    const result = prepareServiceForUpdate({
      serviceName: "test",
      mode: "replicated",
      tty: null,
      dir: null,
      command: null,
    });
    assert.equal(result.serviceName, "test");
    assert.equal("tty" in result, false);
    assert.equal("dir" in result, false);
    assert.equal("command" in result, false);
  });

  it("strips read-only fields", () => {
    const result = prepareServiceForUpdate({
      id: "abc123",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
      state: "running",
      status: { tasks: { running: 1, total: 1 } },
      serviceName: "test",
      mode: "replicated",
    });
    assert.equal("id" in result, false);
    assert.equal("createdAt" in result, false);
    assert.equal("updatedAt" in result, false);
    assert.equal("state" in result, false);
    assert.equal("status" in result, false);
    assert.equal(result.serviceName, "test");
  });

  it("trims repository to name and tag only", () => {
    const result = prepareServiceForUpdate({
      serviceName: "test",
      mode: "replicated",
      repository: {
        name: "nginx",
        tag: "alpine",
        image: "nginx:alpine",
        imageDigest: "sha256:abc123",
      },
    });
    const repo = result.repository as Record<string, unknown>;
    assert.equal(repo.name, "nginx");
    assert.equal(repo.tag, "alpine");
    assert.equal("image" in repo, false);
    assert.equal("imageDigest" in repo, false);
  });

  it("handles repository with empty imageDigest", () => {
    const result = prepareServiceForUpdate({
      serviceName: "test",
      mode: "replicated",
      repository: {
        name: "nginx",
        tag: "alpine",
        image: "nginx:alpine",
        imageDigest: "",
      },
    });
    const repo = result.repository as Record<string, unknown>;
    assert.equal(repo.name, "nginx");
    assert.equal(repo.tag, "alpine");
    assert.equal("imageDigest" in repo, false);
  });
});

describe("resolveData", () => {
  it("returns plain strings as-is", () => {
    assert.equal(resolveData("hello"), "hello");
  });

  it("reads from file path via $file", () => {
    const path = "/tmp/mcp-swarmpit-test-data.txt";
    writeFileSync(path, "contents from file");
    try {
      assert.equal(resolveData({ $file: path }), "contents from file");
    } finally {
      unlinkSync(path);
    }
  });

  it("resolves $env references", () => {
    process.env.TEST_DATA_VAR = "env-value";
    assert.equal(resolveData({ $env: "TEST_DATA_VAR" }), "env-value");
    delete process.env.TEST_DATA_VAR;
  });

  it("throws on missing file", () => {
    assert.throws(() => resolveData({ $file: "/nonexistent/path/xyz" }), /could not be read/);
  });

  it("throws on invalid value type", () => {
    assert.throws(() => resolveData(42), /Invalid data/);
  });
});
