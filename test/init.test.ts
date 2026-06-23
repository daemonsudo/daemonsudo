// `daemonsudo init` writes a curated gate.yaml; every shipped preset must
// parse cleanly through loadConfig.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const ROOT = join(import.meta.dir, "..");
const PRESETS = readdirSync(join(ROOT, "presets")).filter((f) => f.endsWith(".yaml"));

const cli = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["bun", join(ROOT, "src", "index.ts"), ...args], { cwd });

describe("presets", () => {
  // claude-code.yaml is daemon config for the CC door — it has no MCP rules.
  const MCP_PRESETS = PRESETS.filter((f) => f !== "claude-code.yaml");

  test("all presets parse and are safe by default", () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(7); // default + 5 curated + claude-code
    for (const file of MCP_PRESETS) {
      const config = loadConfig(join(ROOT, "presets", file));
      expect(config.defaults).toBe("approve");
      expect(config.rules.length).toBeGreaterThan(0);
      expect(config.redact.length).toBeGreaterThan(0);
      expect(config.telemetry).toBe(false); // opt-in only — no preset enables it
    }
  });

  test("claude-code preset is daemon config with no MCP rules", () => {
    const config = loadConfig(join(ROOT, "presets", "claude-code.yaml"));
    expect(config.rules.length).toBe(0);
    expect(config.redact.length).toBeGreaterThan(0);
  });

  test("curated presets carry deny rules for the destructive tier", () => {
    for (const name of ["postgres", "github", "stripe"]) {
      const config = loadConfig(join(ROOT, "presets", `${name}.yaml`));
      expect(config.rules.some((r) => r.action === "deny")).toBe(true);
    }
  });
});

describe("daemonsudo init", () => {
  test("writes the skeleton, refuses to overwrite", () => {
    const cwd = tmpDir();
    const first = cli(cwd, "init");
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(cwd, "gate.yaml"))).toBe(true);
    expect(loadConfig(join(cwd, "gate.yaml")).defaults).toBe("approve");

    const second = cli(cwd, "init");
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain("already exists");
  }, 20000);

  test("--preset github writes the curated rules", () => {
    const cwd = tmpDir();
    const res = cli(cwd, "init", "--preset", "github");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("preset: github");
    const config = loadConfig(join(cwd, "gate.yaml"));
    expect(config.rules.find((r) => r.pattern === "get_*")?.action).toBe("auto");
    expect(config.rules.find((r) => r.pattern === "delete_*")?.action).toBe("deny");
  }, 20000);

  test("unknown preset → exit 2 listing what exists", () => {
    const cwd = tmpDir();
    const res = cli(cwd, "init", "--preset", "nope");
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain("unknown preset");
    expect(res.stderr.toString()).toContain("postgres");
    expect(existsSync(join(cwd, "gate.yaml"))).toBe(false);
  }, 20000);
});
