import { describe, expect, test } from "bun:test";
import { YamlGlobEngine } from "../src/rules.js";

describe("YamlGlobEngine", () => {
  const engine = new YamlGlobEngine(
    [
      { pattern: "read_*", action: "auto" },
      { pattern: "delete_*", action: "approve" },
      { pattern: "delete_temp_file", action: "auto" },
      { pattern: "drop_*", action: "deny" },
      { pattern: "send_?", action: "approve" },
    ],
    "approve",
  );

  test("plain glob match", () => {
    expect(engine.match("read_thing")).toEqual({ action: "auto", rule: "read_*: auto" });
    expect(engine.match("drop_tables")).toEqual({ action: "deny", rule: "drop_*: deny" });
  });

  test("most-specific glob wins over earlier broader rule", () => {
    expect(engine.match("delete_temp_file").action).toBe("auto");
    expect(engine.match("delete_user").action).toBe("approve");
  });

  test("? matches exactly one character", () => {
    expect(engine.match("send_x").rule).toBe("send_?: approve");
    expect(engine.match("send_xy").rule).toBe("defaults: approve");
  });

  test("unknown tools fall back to defaults", () => {
    expect(engine.match("mystery_tool")).toEqual({ action: "approve", rule: "defaults: approve" });
  });

  test("file order breaks specificity ties", () => {
    const tie = new YamlGlobEngine(
      [
        { pattern: "a*", action: "deny" },
        { pattern: "*a", action: "auto" },
      ],
      "approve",
    );
    expect(tie.match("aa").action).toBe("deny");
  });

  test("glob metacharacters from regex are inert", () => {
    const e = new YamlGlobEngine([{ pattern: "a.b*", action: "deny" }], "auto");
    expect(e.match("a.bc").action).toBe("deny");
    expect(e.match("aXbc").action).toBe("auto");
  });
});
