import { describe, expect, it } from "vitest";
import { createMockTangentClient, nasScenario } from "./index";

describe("mock client: reasoning effort in hostMeta (G1, like the reference server)", () => {
  it("keeps a new line's effort and changes or clears it on update, other fields untouched", async () => {
    const c = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
    const line = await c.createLine({ title: "t", provider: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "high" });
    expect(line.hostMeta).toEqual({ reasoningEffort: "high" });
    expect(line).not.toHaveProperty("reasoningEffort");
    const changed = await c.updateLine(line.id, { reasoningEffort: "Low" });
    expect(changed.hostMeta).toEqual({ reasoningEffort: "low" });
    expect(changed.title).toBe("t");
    const cleared = await c.updateLine(line.id, { reasoningEffort: "", model: "claude-haiku-5-5" });
    expect(cleared.hostMeta).toEqual({});
    expect(cleared.model).toBe("claude-haiku-5-5");
    expect(cleared).not.toHaveProperty("reasoningEffort");
    expect((await c.createLine({ title: "plain" })).hostMeta).toEqual({});
  });
});
