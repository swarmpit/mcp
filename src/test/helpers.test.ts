import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolResult, toolError, resolveEnvRef } from "../tools/helpers.js";

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
