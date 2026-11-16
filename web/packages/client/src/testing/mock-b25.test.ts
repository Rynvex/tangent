import { describe, expect, it } from "vitest";
import { hasErrorCode, normalizeLine } from "../index";
import { createMockTangentClient, NAS_ROOT_ID } from "./index";

describe("B25 import batches and line pinning", () => {
  it("normalizeLine preserves importBatchId and pinnedAt only when non-empty", () => {
    const plain = normalizeLine({ id: "l1" });
    expect("importBatchId" in plain).toBe(false);
    expect("pinnedAt" in plain).toBe(false);

    const b1 = "00000000-0000-4000-8000-000000000001";
    const pinnedAt = "2026-01-01T00:00:00Z";
    const rich = normalizeLine({ id: "l2", importBatchId: b1, pinnedAt });
    expect(rich.importBatchId).toBe(b1);
    expect(rich.pinnedAt).toBe(pinnedAt);
  });

  it("validates batchId and batchLabel and undoes batches by force flag and state", async () => {
    const client = createMockTangentClient({ chunkMs: 1, draftMs: 1 });
    try {
      await expect(
        client.importConversation({
          batchLabel: "no-id.json",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toSatisfy((err) => hasErrorCode(err, "invalid_input") && err.extra.field === "batchLabel");

      await expect(
        client.importConversation({
          batchId: "00000000-0000-0000-0000-000000000000",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toSatisfy((err) => hasErrorCode(err, "invalid_input") && err.extra.field === "batchId");

      await expect(
        client.importConversation({
          batchId: "00000000-0000-4000-8000-000000000010",
          batchLabel: "x".repeat(121),
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toSatisfy((err) => hasErrorCode(err, "invalid_input") && err.extra.field === "batchLabel");

      const batchId = "00000000-0000-4000-8000-000000000099";
      const target = await client.importConversation({
        title: "Target",
        messages: [{ role: "user", content: "base" }, { role: "assistant", content: "ok" }],
      });
      const first = await client.importConversation({
        batchId,
        batchLabel: "first.json",
        title: "First",
        messages: [{ role: "user", content: "one" }, { role: "assistant", content: "a1" }],
      });
      const second = await client.importConversation({
        batchId,
        batchLabel: "second.json",
        title: "Second",
        messages: [{ role: "user", content: "two" }, { role: "assistant", content: "a2" }],
      });
      const third = await client.importConversation({
        batchId,
        title: "Third",
        messages: [{ role: "user", content: "three" }, { role: "assistant", content: "a3" }],
      });

      // Pinning first does not count as changed; attaching third marks it attached; adding a note on second marks it changed.
      await client.updateLine(first.line.id, { pinned: true });
      await client.createNote(second.line.id, { section: "decided", text: "keep me" });
      await client.attachLine(target.line.id, { sourceLineId: third.line.id, purpose: "attached branch" });

      const listed = await client.listImportBatches();
      expect(listed.imports).toHaveLength(1);
      expect(listed.imports[0]).toMatchObject({
        id: batchId,
        label: "first.json",
        lineCount: 3,
        standaloneCount: 2,
      });

      const undo1 = await client.deleteImportBatch(batchId);
      expect(undo1.deleted).toEqual([first.line.id]);
      expect(undo1.kept).toEqual([
        { lineId: second.line.id, reason: "changed" },
        { lineId: third.line.id, reason: "attached" },
      ]);

      // Force deletes changed (second) while still keeping attached (third).
      const undo2 = await client.deleteImportBatch(batchId, { force: true });
      expect(undo2.deleted).toEqual([second.line.id]);
      expect(undo2.kept).toEqual([{ lineId: third.line.id, reason: "attached" }]);

      // Deleting an unused batch removes the batch row too.
      const cleanBatch = "00000000-0000-4000-8000-000000000098";
      const clean = await client.importConversation({
        batchId: cleanBatch,
        batchLabel: "clean.json",
        title: "Clean",
        messages: [{ role: "user", content: "clean" }, { role: "assistant", content: "ok" }],
      });
      const undoClean = await client.deleteImportBatch(cleanBatch);
      expect(undoClean).toEqual({ deleted: [clean.line.id], kept: [] });
      await expect(client.deleteImportBatch(cleanBatch)).rejects.toSatisfy((err) => hasErrorCode(err, "import_batch_not_found"));
    } finally {
      client.mock.dispose();
    }
  });

  it("pins and unpins main lines without bumping activity, rejects branches and cursors, and clears pin on attach/spinoff", async () => {
    let tick = 1_000;
    const client = createMockTangentClient({ chunkMs: 1, draftMs: 1, now: () => new Date(1_760_000_000_000 + (tick += 1000)) });
    try {
      const a = await client.importConversation({
        batchId: "00000000-0000-4000-8000-0000000000aa",
        batchLabel: "pin.json",
        title: "Alpha",
        messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
      });
      const b = (
        await client.importConversation({
          title: "Beta",
          messages: [
            { role: "user", content: "beta q" },
            { role: "assistant", content: "beta a" },
          ],
        })
      ).line;

      const pinnedA = await client.updateLine(a.line.id, { pinned: true });
      expect(pinnedA.pinnedAt).toBeDefined();
      expect(pinnedA.lastActivityAt).toBe(a.line.lastActivityAt);

      // Re-pinning preserves the original pinnedAt.
      const repinnedA = await client.updateLine(a.line.id, { pinned: true });
      expect(repinnedA.pinnedAt).toBe(pinnedA.pinnedAt);

      const pinnedB = await client.updateLine(b.id, { pinned: true });
      const listPinned = await client.listLines({ pinned: true });
      expect(listPinned.lines.map((l) => l.id)).toEqual([b.id, a.line.id]);
      expect(listPinned.nextCursor).toBe("");

      await expect(client.listLines({ pinned: true, cursor: "1" })).rejects.toSatisfy(
        (err) => hasErrorCode(err, "invalid_input") && err.extra.field === "cursor",
      );

      // Branch rejects pinned: true, allows pinned: false as no-op.
      const branch = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "branch", kind: "investigate" });
      await expect(client.updateLine(branch.line.id, { pinned: true })).rejects.toSatisfy(
        (err) => hasErrorCode(err, "invalid_input") && err.extra.field === "pinned",
      );
      await client.updateLine(branch.line.id, { pinned: false });

      // Attach clears pinnedAt but keeps importBatchId; spinoff detach clears both.
      await client.attachLine(b.id, { sourceLineId: a.line.id, purpose: "attached-a" });
      const attachedA = await client.getLine(a.line.id);
      expect(attachedA.pinnedAt).toBeUndefined();
      expect(attachedA.importBatchId).toBe(a.line.importBatchId);

      const detached = await client.spinoff(a.line.id, { mode: "detach", title: "Detached A" });
      expect(detached.line.pinnedAt).toBeUndefined();
      expect(detached.line.importBatchId).toBeUndefined();

      const unpinnedB = await client.updateLine(pinnedB.id, { pinned: false });
      expect(unpinnedB.pinnedAt).toBeUndefined();
    } finally {
      client.mock.dispose();
    }
  });
});
