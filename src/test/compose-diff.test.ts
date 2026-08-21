import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffCompose, unescapeCompose } from "../compose-diff.js";

const base = `version: "3.8"
services:
  web:
    image: nginx:1.0
    restart: always
    ports:
      - "80:80"
    environment:
      LOG_LEVEL: info
      DB_PASSWORD: old-secret
  worker:
    image: worker:1.0
    restart: always
`;

describe("diffCompose", () => {
  it("attributes a changed value to its service and key", () => {
    const after = base.replace("nginx:1.0", "nginx:2.0");
    const d: any = diffCompose(base, after);
    assert.equal(d.changed, true);
    assert.deepEqual(d.services.changed.web.image, { from: "nginx:1.0", to: "nginx:2.0" });
    assert.equal(d.services.changed.worker, undefined);
  });

  it("reports added and removed services by name", () => {
    const after = base.replace(/  worker:\n.*\n.*\n/, "  cache:\n    image: redis:7\n");
    const d: any = diffCompose(base, after);
    assert.deepEqual(d.services.added, ["cache"]);
    assert.deepEqual(d.services.removed, ["worker"]);
  });

  it("sees a change the line-set diff would miss (duplicate lines)", () => {
    // `restart: always` appears twice in base and once after — set membership
    // says "still present", so the old line diff reported nothing.
    const after = base.replace("  worker:\n    image: worker:1.0\n    restart: always\n", "");
    const beforeLines = new Set(base.split("\n"));
    const lineDiffSeesNothing = after
      .split("\n")
      .filter((l) => l.trim() && !beforeLines.has(l)).length === 0;
    assert.ok(lineDiffSeesNothing, "precondition: a line diff finds no additions here");

    const d: any = diffCompose(base, after);
    assert.deepEqual(d.services.removed, ["worker"]);
  });

  it("does not report reordered keys as a change", () => {
    const reordered = `services:
  web:
    restart: always
    ports:
      - "80:80"
    image: nginx:1.0
    environment:
      DB_PASSWORD: old-secret
      LOG_LEVEL: info
  worker:
    image: worker:1.0
    restart: always
version: "3.8"
`;
    assert.equal(diffCompose(base, reordered).changed, false);
  });

  it("treats $$ escaping as equivalent to $", () => {
    const escaped = 'services:\n  web:\n    command: echo $$HOME\n';
    const plain = 'services:\n  web:\n    command: echo $HOME\n';
    assert.equal(diffCompose(escaped, plain).changed, false);
    assert.equal(unescapeCompose("$$FOO"), "$FOO");
  });

  it("diffs list entries as added/removed rather than whole-list replacement", () => {
    const after = base.replace('      - "80:80"', '      - "80:80"\n      - "443:443"');
    const d: any = diffCompose(base, after);
    assert.deepEqual(d.services.changed.web.ports, { added: ['443:443'] });
  });

  it("handles both env syntaxes as the same thing", () => {
    const listForm = `services:
  web:
    image: nginx:1.0
    restart: always
    ports:
      - "80:80"
    environment:
      - LOG_LEVEL=info
      - DB_PASSWORD=old-secret
  worker:
    image: worker:1.0
    restart: always
version: "3.8"
`;
    assert.equal(diffCompose(base, listForm).changed, false);
  });

  it("reports env additions and removals by name", () => {
    const after = base
      .replace("      LOG_LEVEL: info\n", "")
      .replace("    environment:", "    environment:\n      NEW_VAR: 1");
    const d: any = diffCompose(base, after);
    assert.deepEqual(d.services.changed.web.environment.added, ["NEW_VAR"]);
    assert.deepEqual(d.services.changed.web.environment.removed, ["LOG_LEVEL"]);
  });

  describe("redaction", () => {
    const after = base
      .replace("old-secret", "new-secret")
      .replace("LOG_LEVEL: info", "LOG_LEVEL: debug");

    it("hides every value in all mode", () => {
      const d: any = diffCompose(base, after, { redact: "all" });
      assert.deepEqual(d.services.changed.web.environment.changed.sort(), ["DB_PASSWORD", "LOG_LEVEL"]);
      const raw = JSON.stringify(d);
      assert.equal(raw.includes("new-secret"), false);
      assert.equal(raw.includes("debug"), false);
    });

    it("shows non-sensitive values in sensitive mode, hides the rest", () => {
      const d: any = diffCompose(base, after, { redact: "sensitive" });
      const changed = d.services.changed.web.environment.changed;
      assert.ok(changed.includes("DB_PASSWORD"), "sensitive name stays a bare name");
      assert.deepEqual(
        changed.find((c: any) => c?.name === "LOG_LEVEL"),
        { name: "LOG_LEVEL", from: "info", to: "debug" }
      );
      assert.equal(JSON.stringify(d).includes("new-secret"), false);
    });

    it("shows everything in none mode", () => {
      const d: any = diffCompose(base, after, { redact: "none" });
      const changed = d.services.changed.web.environment.changed;
      assert.deepEqual(
        changed.find((c: any) => c?.name === "DB_PASSWORD"),
        { name: "DB_PASSWORD", from: "old-secret", to: "new-secret" }
      );
    });

    it("always names changed secrets, whatever the mode", () => {
      for (const redact of ["all", "sensitive", "none"] as const) {
        const d: any = diffCompose(base, after, { redact });
        assert.ok(d.secretsChanged.includes("DB_PASSWORD"), `mode ${redact}`);
      }
    });
  });

  it("compares top-level sections too", () => {
    const withNetwork = base + "networks:\n  backend:\n    driver: overlay\n";
    const d: any = diffCompose(base, withNetwork);
    assert.deepEqual(d.networks.added, ["backend"]);
  });

  it("falls back to a text comparison on unparseable yaml", () => {
    const d = diffCompose(base, "services:\n  web:\n   - bad\n  : :\n");
    assert.equal(d.changed, true);
    assert.ok(d.parseError, "reports why it could not parse");
  });

  it("reports no change for identical documents", () => {
    assert.deepEqual(diffCompose(base, base), { changed: false });
  });
});
