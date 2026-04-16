import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeService,
  sanitizeServices,
  sanitizeComposeYaml,
  resolveComposeEnvRefs,
  restoreRedactedValues,
  setExtraRedactPatterns,
} from "../sanitize.js";
import type { SwarmpitService } from "../types.js";

function makeService(overrides: Partial<SwarmpitService> = {}): SwarmpitService {
  return {
    id: "test-id",
    version: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    repository: { name: "test", tag: "latest", image: "test:latest", imageDigest: "sha256:abc" },
    serviceName: "test_service",
    mode: "replicated",
    replicas: 1,
    state: "running",
    status: { tasks: { running: 1, total: 1 }, update: "", message: "" },
    ports: [],
    mounts: [],
    networks: [],
    secrets: [],
    configs: [],
    variables: [],
    labels: [],
    command: null,
    stack: "test",
    resources: { reservation: { cpu: 0, memory: 0 }, limit: { cpu: 0, memory: 0 } },
    ...overrides,
  };
}

describe("sanitizeService", () => {
  it("redacts all env vars when redactAll=true", () => {
    const service = makeService({
      variables: [
        { name: "NODE_ENV", value: "production" },
        { name: "DB_PASS", value: "secret123" },
      ],
    });
    const result = sanitizeService(service, true);
    assert.equal(result.variables[0].value, "[REDACTED]");
    assert.equal(result.variables[1].value, "[REDACTED]");
  });

  it("only redacts sensitive vars when redactAll=false", () => {
    const service = makeService({
      variables: [
        { name: "NODE_ENV", value: "production" },
        { name: "DB_PASS", value: "secret123" },
        { name: "API_KEY", value: "key123" },
        { name: "LOG_LEVEL", value: "debug" },
        { name: "SECRET_VALUE", value: "hidden" },
        { name: "AUTH_HEADER", value: "bearer xyz" },
      ],
    });
    const result = sanitizeService(service, false);
    assert.equal(result.variables[0].value, "production");  // NODE_ENV — not sensitive
    assert.equal(result.variables[1].value, "[REDACTED]");  // DB_PASS — matches "pass"
    assert.equal(result.variables[2].value, "[REDACTED]");  // API_KEY — matches "key"
    assert.equal(result.variables[3].value, "debug");        // LOG_LEVEL — not sensitive
    assert.equal(result.variables[4].value, "[REDACTED]");  // SECRET_VALUE — matches "secret"
    assert.equal(result.variables[5].value, "[REDACTED]");  // AUTH_HEADER — matches "auth"
  });

  it("redacts extra custom patterns", () => {
    setExtraRedactPatterns(["GRAFANA", "RPC"]);
    const service = makeService({
      variables: [
        { name: "GRAFANA", value: "https://grafana.example.com" },
        { name: "RPC_URL", value: "ws://node:9999" },
        { name: "LOG_LEVEL", value: "debug" },
      ],
    });
    const result = sanitizeService(service, false);
    assert.equal(result.variables[0].value, "[REDACTED]");  // GRAFANA — custom pattern
    assert.equal(result.variables[1].value, "[REDACTED]");  // RPC_URL — custom pattern
    assert.equal(result.variables[2].value, "debug");        // LOG_LEVEL — no match
    setExtraRedactPatterns([]);  // clean up
  });

  it("preserves env var names", () => {
    const service = makeService({
      variables: [{ name: "PASSWORD", value: "secret" }],
    });
    const result = sanitizeService(service, true);
    assert.equal(result.variables[0].name, "PASSWORD");
  });

  it("does not modify command args", () => {
    const service = makeService({
      command: ["--db", "postgres://user:secret@host:5432/db"],
    });
    const result = sanitizeService(service, true);
    assert.deepEqual(result.command, ["--db", "postgres://user:secret@host:5432/db"]);
  });

  it("strips secret data fields but keeps references", () => {
    const service = makeService({
      secrets: [{ id: "s1", secretName: "db_pass", secretTarget: "/run/secrets/db_pass" }],
      configs: [{ id: "c1", configName: "app_config", configTarget: "/etc/app.conf" }],
    });
    const result = sanitizeService(service);
    assert.deepEqual(result.secrets, [{ id: "s1", secretName: "db_pass", secretTarget: "/run/secrets/db_pass" }]);
    assert.deepEqual(result.configs, [{ id: "c1", configName: "app_config", configTarget: "/etc/app.conf" }]);
  });
});

describe("sanitizeServices", () => {
  it("sanitizes an array of services", () => {
    const services = [
      makeService({ variables: [{ name: "PASSWORD", value: "s1" }] }),
      makeService({ variables: [{ name: "TOKEN", value: "s2" }] }),
    ];
    const result = sanitizeServices(services, false);
    assert.equal(result[0].variables[0].value, "[REDACTED]");
    assert.equal(result[1].variables[0].value, "[REDACTED]");
  });
});

describe("sanitizeComposeYaml", () => {
  it("redacts all env vars in key-value form when redactAll=true", () => {
    const yaml = `services:
  app:
    environment:
      NODE_ENV: production
      DB_HOST: localhost`;
    const result = sanitizeComposeYaml(yaml, true);
    assert.ok(result.includes("NODE_ENV: [REDACTED]"));
    assert.ok(result.includes("DB_HOST: [REDACTED]"));
  });

  it("only redacts sensitive vars when redactAll=false", () => {
    const yaml = `services:
  app:
    environment:
      NODE_ENV: production
      DB_PASSWORD: secret123`;
    const result = sanitizeComposeYaml(yaml, false);
    assert.ok(result.includes("NODE_ENV: production"));
    assert.ok(result.includes("DB_PASSWORD: [REDACTED]"));
  });

  it("redacts list form env vars", () => {
    const yaml = `services:
  app:
    environment:
      - NODE_ENV=production
      - DB_PASSWORD=secret123`;
    const result = sanitizeComposeYaml(yaml, false);
    assert.ok(result.includes("- NODE_ENV=production"));
    assert.ok(result.includes("- DB_PASSWORD=[REDACTED]"));
  });

  it("does not redact YAML references or objects", () => {
    const yaml = `services:
  app:
    environment:
      CONFIG: &default_config
      REF: *default_config`;
    const result = sanitizeComposeYaml(yaml, true);
    assert.ok(result.includes("CONFIG: &default_config"));
    assert.ok(result.includes("REF: *default_config"));
  });

  it("does not modify commands in compose", () => {
    const yaml = `services:
  app:
    command: ["--db", "postgres://user:secret@host/db"]`;
    const result = sanitizeComposeYaml(yaml, true);
    assert.ok(result.includes("postgres://user:secret@host/db"));
  });
});

describe("resolveComposeEnvRefs", () => {
  it("resolves $env:VAR_NAME in key-value form", () => {
    process.env.TEST_SECRET = "resolved-value";
    const yaml = `    DB_PASSWORD: $env:TEST_SECRET`;
    const result = resolveComposeEnvRefs(yaml);
    assert.ok(result.includes("DB_PASSWORD: resolved-value"));
    delete process.env.TEST_SECRET;
  });

  it("resolves $env:VAR_NAME in list form", () => {
    process.env.TEST_SECRET = "resolved-value";
    const yaml = `      - DB_PASSWORD=$env:TEST_SECRET`;
    const result = resolveComposeEnvRefs(yaml);
    assert.ok(result.includes("- DB_PASSWORD=resolved-value"));
    delete process.env.TEST_SECRET;
  });

  it("passes through plain values unchanged", () => {
    const yaml = `    NODE_ENV: production`;
    const result = resolveComposeEnvRefs(yaml);
    assert.equal(result, yaml);
  });

  it("throws on missing env var", () => {
    delete process.env.NONEXISTENT_VAR;
    const yaml = `    DB_PASSWORD: $env:NONEXISTENT_VAR`;
    assert.throws(() => resolveComposeEnvRefs(yaml), /NONEXISTENT_VAR/);
  });
});

describe("restoreRedactedValues", () => {
  it("restores [REDACTED] from original in key-value form", () => {
    const edited = `    DB_PASSWORD: [REDACTED]\n    NODE_ENV: staging`;
    const original = `    DB_PASSWORD: secret123\n    NODE_ENV: production`;
    const result = restoreRedactedValues(edited, original);
    assert.ok(result.includes("DB_PASSWORD: secret123"));
    assert.ok(result.includes("NODE_ENV: staging"));
  });

  it("restores [REDACTED] from original in list form", () => {
    const edited = `      - DB_PASSWORD=[REDACTED]\n      - NODE_ENV=staging`;
    const original = `      - DB_PASSWORD=secret123\n      - NODE_ENV=production`;
    const result = restoreRedactedValues(edited, original);
    assert.ok(result.includes("- DB_PASSWORD=secret123"));
    assert.ok(result.includes("- NODE_ENV=staging"));
  });

  it("leaves non-redacted values as-is", () => {
    const edited = `    NODE_ENV: staging`;
    const original = `    NODE_ENV: production`;
    const result = restoreRedactedValues(edited, original);
    assert.ok(result.includes("NODE_ENV: staging"));
  });
});
