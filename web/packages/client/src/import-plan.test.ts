import { describe, expect, it } from "vitest";
import { IMPORT_MAX_BODY_BYTES, IMPORT_MAX_BRANCH_MESSAGES, IMPORT_MAX_BRANCHES, IMPORT_MAX_MESSAGE_RUNES, IMPORT_MAX_MESSAGES, IMPORT_MAX_OPEN_BRANCHES } from "./b18-routes";
import { buildImportPlan, importBodyBytes, type ImportEdits, type ImportPlanOptions } from "./import-plan";
import type { ParsedBranch, ParsedConversation, ParsedMessage } from "./import-tree";

const message = (n: number, role: "user" | "assistant" = n % 2 === 1 ? "user" : "assistant", content = `message ${n}`): ParsedMessage => ({ externalId: `x${n}`, role, content, versions: 1 });
const conversation = (count: number, branches: ParsedBranch[] = []): ParsedConversation => ({
  id: "c",
  title: "Parsed title",
  createdAt: null,
  updatedAt: null,
  messages: Array.from({ length: count }, (_, index) => message(index + 1)),
  branches,
  skippedBranches: 0,
});
const noEdits: ImportEdits = { roles: {}, removed: new Set() };
const options = (extra: Partial<ImportPlanOptions> = {}): ImportPlanOptions => ({ title: "", folder: "", tags: [], restoreBranches: true, source: "chatgpt", ...extra });
const branch = (anchor: number, reason: ParsedBranch["reason"] = "edit", extra: Partial<ParsedBranch> = {}): ParsedBranch => ({
  anchorExternalId: `x${anchor}`,
  reason,
  messages: [
    { role: "user", content: `another question at ${anchor}` },
    { role: "assistant", content: "another answer" },
  ],
  ...extra,
});

describe("buildImportPlan", () => {
  it("sends the kept messages with fresh ids, switched roles, title, folder, tags and source", () => {
    const plan = buildImportPlan(conversation(4), { roles: { x2: "user" }, removed: new Set(["x3"]) }, options({ title: "  My title ", folder: " 資料庫 ", tags: ["#Postgres", "mvcc", "postgres"] }));
    expect(plan.input).toEqual({
      title: "My title",
      folder: "資料庫",
      tags: ["postgres", "mvcc"],
      source: "chatgpt",
      messages: [
        { externalId: "m1", role: "user", content: "message 1" },
        { externalId: "m2", role: "user", content: "message 2" },
        { externalId: "m3", role: "assistant", content: "message 4" },
      ],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.messageCount).toBe(3);
  });

  it("restores versions with purposes from the labels, hanging a removed anchor's on the kept message before it", () => {
    const labels = { edit: (text: string) => `re-ask: ${text}`, regenerate: (text: string) => `again: ${text}` };
    const plan = buildImportPlan(conversation(4, [branch(2), branch(3, "regenerate")]), { roles: {}, removed: new Set(["x3"]) }, options(), labels);
    expect(plan.input.branches).toEqual([
      { anchorExternalId: "m2", purpose: "re-ask: another question at 2", messages: branch(2).messages },
      { anchorExternalId: "m2", purpose: "again: message 3", messages: branch(3).messages },
    ]);
    expect(plan.branchCount).toBe(2);
  });

  it("sends no branches when restoring is off, and drops a version with nothing kept before it", () => {
    expect(buildImportPlan(conversation(4, [branch(2)]), noEdits, options({ restoreBranches: false })).input.branches).toBeUndefined();
    const plan = buildImportPlan(conversation(4, [branch(1)]), { roles: {}, removed: new Set(["x1"]) }, options());
    expect(plan.input.branches).toBeUndefined();
    expect(plan.droppedBranches).toBe(1);
  });

  it("imports a conversation over 2,000 messages in parts of 2,000, dropping versions outside the chosen part", () => {
    const max = IMPORT_MAX_MESSAGES;
    const long = conversation(2 * max + 50, [branch(10), branch(max + 100)]);
    const first = buildImportPlan(long, noEdits, options());
    expect(first.parts).toBe(3);
    expect(first.messageCount).toBe(max);
    expect(first.partRange).toEqual([1, max]);
    expect(first.branchCount).toBe(1);
    expect(first.droppedBranches).toBe(1);
    const second = buildImportPlan(long, noEdits, options({ part: 1 }));
    expect(second.partRange).toEqual([max + 1, 2 * max]);
    expect(second.input.messages[0]!.content).toBe(`message ${max + 1}`);
    expect(second.input.branches?.[0]?.anchorExternalId).toBe("m100");
    expect(buildImportPlan(long, noEdits, options({ part: 9 })).partRange).toEqual([2 * max + 1, 2 * max + 50]);
  });

  it("keeps at most 50 branches of at most 500 messages and 8 open ones", () => {
    const many = Array.from({ length: IMPORT_MAX_BRANCHES + 3 }, (_, index) =>
      branch(2, "branch", {
        purpose: `b${index}`,
        status: "open",
        messages: Array.from({ length: index === 0 ? IMPORT_MAX_BRANCH_MESSAGES + 20 : 1 }, () => ({ role: "user" as const, content: "x" })),
      }),
    );
    const plan = buildImportPlan(conversation(4, many), noEdits, options());
    expect(plan.branchCount).toBe(IMPORT_MAX_BRANCHES);
    expect(plan.droppedBranches).toBe(3);
    expect(plan.cutBranches).toBe(1);
    expect(plan.input.branches![0]!.messages).toHaveLength(IMPORT_MAX_BRANCH_MESSAGES);
    expect(plan.input.branches!.filter((item) => item.status === "open")).toHaveLength(IMPORT_MAX_OPEN_BRANCHES);
    expect(plan.closedBranches).toBe(IMPORT_MAX_BRANCHES - IMPORT_MAX_OPEN_BRANCHES);
  });

  it("names messages over 32,000 characters, folder and tag problems, and an empty import", () => {
    const parsed = conversation(3);
    parsed.messages[1] = message(2, "assistant", "x".repeat(IMPORT_MAX_MESSAGE_RUNES + 1));
    const plan = buildImportPlan(parsed, noEdits, options({ folder: "__unfiled__", tags: Array.from({ length: 13 }, (_, index) => `t${index}`) }));
    expect(plan.problems).toEqual([
      { kind: "tooLong", numbers: [2] },
      { kind: "folder", problem: "reserved" },
      { kind: "tags", problem: "tooMany" },
    ]);
    const empty = buildImportPlan(conversation(2), { roles: {}, removed: new Set(["x1", "x2"]) }, options());
    expect(empty.problems).toContainEqual({ kind: "noMessages" });
  });

  it("measures the body in UTF-8 bytes and refuses one over 16 MiB", () => {
    expect(importBodyBytes({ messages: [{ role: "user", content: "中" }] })).toBe(JSON.stringify({ messages: [{ role: "user", content: "中" }] }).length + 2);
    const huge = conversation(200);
    huge.messages = huge.messages.map((item) => ({ ...item, content: "中".repeat(30_000) }));
    const plan = buildImportPlan(huge, noEdits, options());
    expect(plan.problems.some((problem) => problem.kind === "bodyTooLarge" && problem.bytes > IMPORT_MAX_BODY_BYTES)).toBe(true);
  });
});

describe("buildImportPlan dates (B19 / F14)", () => {
  const dated = (): ParsedConversation => ({
    ...conversation(3, [branch(2, "regenerate", { messages: [{ role: "assistant", content: "old", createdAt: "2026-08-12T06:30:00.000Z" }] })]),
    createdAt: "2026-08-12T06:20:00.000Z",
    messages: [
      { ...message(1), createdAt: "2026-08-12T06:20:00.000Z" },
      message(2),
      { ...message(3), createdAt: "2026-08-12T09:35:00.000Z" },
    ],
  });

  it("sends each dated message's createdAt, the conversation's and the restored versions'", () => {
    const { input } = buildImportPlan(dated(), noEdits, options());
    expect(input.createdAt).toBe("2026-08-12T06:20:00.000Z");
    expect(input.messages.map((item) => item.createdAt)).toEqual(["2026-08-12T06:20:00.000Z", undefined, "2026-08-12T09:35:00.000Z"]);
    expect(input.branches![0]!.messages[0]!.createdAt).toBe("2026-08-12T06:30:00.000Z");
  });

  it("takes the times it is given instead (a re-timed session), and createdAt null sends none", () => {
    const { input } = buildImportPlan(dated(), noEdits, options({ messageTimes: new Map([["x2", "2026-08-13T00:00:00.000Z"]]), createdAt: null }));
    expect(input.createdAt).toBeUndefined();
    expect(input.messages.map((item) => item.createdAt)).toEqual([undefined, "2026-08-13T00:00:00.000Z", undefined]);
  });
});
