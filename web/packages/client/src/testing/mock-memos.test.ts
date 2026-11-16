import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function setup(features: "all" | "core" = "all") {
  const events: TangentEvent[] = [];
  client = createMockTangentClient({ scenario: nasScenario({ features }), latencyMs: 0, chunkMs: 1, draftMs: 1 });
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  return { c: client, events };
}

const code = async (promise: Promise<unknown>) => promise.then(() => "", (error: unknown) => (error instanceof TangentError ? error.code : String(error)));

describe("mock memos (B13)", () => {
  it("writes a memo on a node with the node's name as label, lists it and publishes memo.changed", async () => {
    const { c, events } = setup();
    const { memo } = await c.createMemo(NAS_ROOT_ID, { lineId: "nas-b3", text: "  warranty\r\nRMA  " });
    expect(memo).toMatchObject({ rootLineId: NAS_ROOT_ID, lineId: "nas-b3", text: "warranty\nRMA", sourceLabel: "查證・4TB 與 8TB 硬碟的每 TB 成本與保固" });
    expect(events.at(-1)).toMatchObject({ type: "memo.changed", data: { rootLineId: NAS_ROOT_ID, memoId: memo.id, change: "created" } });
    expect((await c.listMemos(NAS_ROOT_ID, { lineId: "nas-b3" })).memos.map((item) => item.id)).toEqual([memo.id]);
    expect((await c.listMemos("nas-b3")).memos.length).toBe(2);
    await c.updateMemo(memo.id, "warranty only");
    await c.deleteMemo(memo.id);
    expect(events.slice(-2).map((event) => (event.data as { change: string }).change)).toEqual(["updated", "deleted"]);
    expect(await code(c.deleteMemo(memo.id))).toBe("memo_not_found");
  });

  it("refuses an empty text, a node of another tree, an archived tree, and answers feature_disabled when off", async () => {
    const { c } = setup();
    expect(await code(c.createMemo(NAS_ROOT_ID, { text: " " }))).toBe("invalid_input");
    const other = await c.createLine({ title: "other" });
    expect(await code(c.createMemo(NAS_ROOT_ID, { lineId: other.id, text: "x" }))).toBe("line_not_found");
    await c.archiveLine(NAS_ROOT_ID);
    expect(await code(c.createMemo(NAS_ROOT_ID, { text: "x" }))).toBe("archived");
    const core = setup("core").c;
    expect(await code(core.listMemos(NAS_ROOT_ID))).toBe("feature_disabled");
  });

  it("never puts a memo into the turn's preview", async () => {
    const { c } = setup();
    await c.createMemo(NAS_ROOT_ID, { text: "ZEBRA-MEMO-ONLY" });
    const preview = await c.previewTurn(NAS_ROOT_ID, { content: "next" });
    expect(JSON.stringify(preview)).not.toContain("ZEBRA-MEMO-ONLY");
  });
});
