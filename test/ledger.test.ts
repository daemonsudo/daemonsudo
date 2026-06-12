import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { canonicalJson, Ledger, redact, sha256, type Receipt } from "../src/ledger.js";
import { tmpDir } from "./helpers.js";

describe("canonicalJson", () => {
  test("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 }, u: undefined })).toBe(
      '{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("redact", () => {
  const globs = ["*.password", "*.api_key", "credentials"];

  test("redacts matching leaf paths at any depth, including top level", () => {
    expect(redact({ user: { password: "hunter2", name: "amy" } }, globs)).toEqual({
      user: { password: "[redacted]", name: "amy" },
    });
    expect(redact({ password: "hunter2", id: "1" }, globs)).toEqual({
      password: "[redacted]",
      id: "1",
    });
    expect(redact({ a: { b: { api_key: "sk-123" } } }, globs)).toEqual({
      a: { b: { api_key: "[redacted]" } },
    });
  });

  test("redacts whole subtrees when the glob names a branch", () => {
    expect(redact({ credentials: { user: "x", password: "y" }, other: 1 }, globs)).toEqual({
      credentials: "[redacted]",
      other: 1,
    });
  });

  test("leaves unmatched values untouched", () => {
    const args = { id: "t1", nested: { list: [1, 2] } };
    expect(redact(args, globs)).toEqual(args);
  });
});

describe("Ledger chain", () => {
  test("receipts chain by hash of the previous stored receipt", async () => {
    const db = await openDb(join(tmpDir(), "gate.db"));
    const ledger = new Ledger(db, ["*.password"]);

    const r1 = ledger.append({
      server: "mock",
      tool: "read_thing",
      args: { id: "1" },
      decision: "auto",
      rule: "read_*: auto",
      result: { status: "ok", content_hash: sha256("x") },
    });
    const r2 = ledger.append({
      server: "mock",
      tool: "send_thing",
      args: { id: "2", password: "hunter2" },
      decision: "denied",
      rule: "send_*: approve",
    });

    expect(r1.prev_hash).toBe(sha256("daemonsudo-genesis"));
    expect(r2.prev_hash).toBe(sha256(canonicalJson(r1)));

    // secrets never land raw in the ledger
    const stored = ledger.list(10);
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect((stored[0] as Receipt & { args_redacted: { password: string } }).args_redacted.password).toBe("[redacted]");
    // but the full args are still attestable via the hash
    expect(r2.args_hash).toBe(sha256(canonicalJson({ id: "2", password: "hunter2" })));

    db.close();
  });
});
