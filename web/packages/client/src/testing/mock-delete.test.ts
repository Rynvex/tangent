import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

/** F7: `DELETE /lines/{id}` in the mock, with the server's refusals (store.DeleteTree). */

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof TangentError)) throw new Error(`expected a TangentError, got ${String(error)}`);
  return error;
}

let client: MockTangentClient;
beforeEach(() => {
  vi.useFakeTimers();
  client = createMockTangentClient({ latencyMs: 0, chunkMs: 5 });
});
afterEach(() => {
  client.mock.dispose();
  vi.useRealTimers();
});

describe("mock deleteLine (F7)", () => {
  it("lists the main line first, then every branch of the tree", async () => {
    const result = await client.deleteLine(NAS_ROOT_ID);
    expect(result.rootLineId).toBe(NAS_ROOT_ID);
    expect(result.lineIds[0]).toBe(NAS_ROOT_ID);
    expect(result.lineIds).toEqual(expect.arrayContaining(["nas-b1", "nas-b1a", "nas-b2", "nas-b3"]));
    expect((await client.listLines()).lines.map((line) => line.id)).not.toContain(NAS_ROOT_ID);
  });

  it("refuses a branch with branch_not_main_line", async () => {
    const error = await rejection(client.deleteLine("nas-b2"));
    expect(error).toMatchObject({ status: 409, code: "branch_not_main_line" });
  });

  it("refuses with session_busy while a reply runs anywhere in the tree, and deletes once it ended", async () => {
    await client.sendMessage("nas-b2", { content: "[fake:slow] still thinking" });
    const error = await rejection(client.deleteLine(NAS_ROOT_ID));
    expect(error).toMatchObject({ status: 409, code: "session_busy" });
    expect((await client.getLine(NAS_ROOT_ID)).id).toBe(NAS_ROOT_ID);
    await vi.runAllTimersAsync();
    await expect(client.deleteLine(NAS_ROOT_ID)).resolves.toMatchObject({ rootLineId: NAS_ROOT_ID });
  });

  it("deletes an archived conversation too", async () => {
    await expect(client.deleteLine("arch-1")).resolves.toMatchObject({ rootLineId: "arch-1", lineIds: ["arch-1"] });
    expect((await client.listLines({ archived: true })).lines.map((line) => line.id)).toEqual(["arch-2"]);
  });

  it("takes the tree's own records along, and other trees' links to it (the server cascades)", async () => {
    const spun = await client.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m40" });
    await vi.runAllTimersAsync();
    expect((await client.listLinks(spun.line.id)).links).toHaveLength(1);
    await client.deleteLine(NAS_ROOT_ID);
    expect((await client.listLinks(spun.line.id)).links).toEqual([]);
    expect((await rejection(client.listSeeds(NAS_ROOT_ID))).code).toBe("line_not_found");
  });
});
