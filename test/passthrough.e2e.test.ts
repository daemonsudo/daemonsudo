// Stage 1 exit test: the gate is a transparent pipe. A client must behave
// identically with the gate inserted — same server info, same tool list,
// same tool results, pings work.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectDirect, connectThroughGate, ROOT, tmpDir } from "./helpers.js";

describe("transparent passthrough", () => {
  test("client sees the same server through the gate", async () => {
    const direct = await connectDirect();
    const gated = await connectThroughGate({
      config: join(ROOT, "test", "fixtures", "auto.yaml"),
      env: { DAEMONSUDO_DB: join(tmpDir(), "gate.db") },
    });

    expect(gated.getServerVersion()?.name).toBe(direct.getServerVersion()?.name);

    const directTools = await direct.listTools();
    const gatedTools = await gated.listTools();
    expect(gatedTools.tools.map((t) => t.name).sort()).toEqual(
      directTools.tools.map((t) => t.name).sort(),
    );
    expect(gatedTools.tools.length).toBe(4);

    const directRes = await direct.callTool({ name: "read_thing", arguments: { id: "x1" } });
    const gatedRes = await gated.callTool({ name: "read_thing", arguments: { id: "x1" } });
    expect(gatedRes.content).toEqual(directRes.content);

    await expect(gated.ping()).resolves.toBeDefined();

    await direct.close();
    await gated.close();
  }, 20000);
});
