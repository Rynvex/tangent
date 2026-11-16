import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { threadByTopicShifts } from "./import-topics";
import { routeSample } from "./contract-samples";
import { TangentError } from "./errors";
import { IMPORT_ANALYZE_MAX_UNITS, IMPORT_ANALYZE_TEXT_RUNES, normalizeImportAnalyzePlan, type ImportAnalyzeInput, type ImportAnalyzeUnit } from "./import-analyze";
import { analyzeImportLocal, normalizeImportAnalyzeInput } from "./import-analyze-local";
import { INTERLEAVED_ROUNDS } from "./import-combined-fixtures";
import { IMPORT_MAX_BRANCH_MESSAGES, IMPORT_MAX_MESSAGES } from "./b18-routes";

const units = (): ImportAnalyzeUnit[] => INTERLEAVED_ROUNDS.map(([question, answer], index) => ({ key: `u${index + 1}`, question, answer, messageCount: 2 }));
const nodeOf = (plan: ReturnType<typeof analyzeImportLocal>, key: string) => plan.nodes.find((node) => node.key === key);

function fieldOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TangentError && error.code === "invalid_input") return String(error.extra?.field);
    throw error;
  }
  return undefined;
}

describe("analyzeImportLocal (the server's heuristic, without a server)", () => {
  it("makes exactly the server's plan for the contract sample (A → B → A → C → A → B)", () => {
    // Arrange
    const sample = routeSample("route.lines.import_analyze");
    // Act
    const plan = analyzeImportLocal(sample.request as ImportAnalyzeInput);
    // Assert
    expect(plan).toEqual(sample.response);
  });

  it("makes exactly the server's plan for the twelve weekend rounds, where an answer's word must not pull another topic along", () => {
    // Arrange: the coordinator's probe and the Go plan (domain/import_analyze_weekend_test.go writes it).
    const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../domain/testdata/${name}`, import.meta.url)), "utf8")) as unknown;
    const input = read("import_analyze_weekend.input.json") as ImportAnalyzeInput;
    // Act
    const plan = analyzeImportLocal(input);
    // Assert
    expect(plan).toEqual(read("import_analyze_weekend.plan.json"));
    expect(plan.nodes.map((node) => node.unitKeys)).toEqual([["r1", "r3", "r6", "r7", "r9", "r12"], ["r2", "r5", "r10", "r11"], ["r4"], ["r8"]]);
    // The same rounds as one undated combined list thread the same way.
    const messages = input.units.flatMap((unit, n) => [
      { externalId: `q${n}`, role: "user" as const, content: unit.question, versions: 1 },
      { externalId: `a${n}`, role: "assistant" as const, content: unit.answer, versions: 1 },
    ]);
    expect(threadByTopicShifts(messages, "combined").map((topic) => topic.rounds)).toEqual([[1, 3, 6, 7, 9, 12], [2, 5, 10, 11], [4], [8]]);
  });

  it("makes the server's plan for every sample of the evaluation set (domain/testdata/import_analyze_eval)", () => {
    // The node lists the Go heuristic gives (domain/import_analyze_eval_test.go logs them): keep both sides equal.
    const read = (name: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../domain/testdata/import_analyze_eval/${name}.json`, import.meta.url)), "utf8")) as ImportAnalyzeInput;
    const nodesOf = (name: string) => analyzeImportLocal(read(name)).nodes.map((node) => [node.role, node.unitKeys]);
    expect(nodesOf("cooling")).toEqual([
      ["chapter", ["u1", "u3", "u5"]],
      ["merged_branch", ["u2", "u6"]],
      ["merged_branch", ["u4"]],
    ]);
    expect(nodesOf("mvcc")).toEqual([
      ["chapter", ["m1", "m2", "m3", "m6", "m7"]],
      ["merged_branch", ["m4", "m5"]],
      ["chapter", ["m8", "m9"]],
    ]);
    expect(nodesOf("pgpool")).toEqual([
      ["chapter", ["p1", "p2"]],
      ["chapter", ["p3", "p4", "p5", "p6"]],
      ["chapter", ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"]],
    ]);
  });

  it("does not make opening small talk the chapter: the first core topic is", () => {
    const plan = analyzeImportLocal({
      units: [
        { key: "s1", question: "嗨，今天天氣真好", answer: "是啊，適合出門走走。", messageCount: 2 },
        { key: "a1", question: "Kubernetes 的 pod 一直重啟怎麼查?", answer: "先看 kubectl describe pod 的事件。", messageCount: 2 },
        { key: "a2", question: "describe 說 OOMKilled，要怎麼調?", answer: "提高 memory limit 或找記憶體洩漏。", messageCount: 2 },
        { key: "z1", question: "咖啡豆怎麼保存?", answer: "密封、避光、放陰涼處。", messageCount: 2 },
      ],
    });
    expect(plan.nodes.map((node) => `${node.key}:${node.role}`)).toEqual(["s1:standalone", "a1:chapter", "z1:standalone"]);
  });

  it("threads A's rounds into one chapter and hangs B and C on it after the right rounds, with cards", () => {
    const plan = analyzeImportLocal({ units: units() });
    expect(plan.nodes.map((node) => [node.key, node.role, node.unitKeys])).toEqual([
      ["u1", "chapter", ["u1", "u3", "u5"]],
      ["u2", "merged_branch", ["u2", "u6"]],
      ["u4", "merged_branch", ["u4"]],
    ]);
    expect(nodeOf(plan, "u2")).toMatchObject({ attachToKey: "u1", attachAfterUnitKey: "u1", conclusion: INTERLEAVED_ROUNDS[5]![1] });
    expect(nodeOf(plan, "u4")).toMatchObject({ attachToKey: "u1", attachAfterUnitKey: "u3", conclusion: INTERLEAVED_ROUNDS[3]![1] });
    expect(plan.source).toBe("heuristic");
  });

  it("moves a role the import has no room for, as the tree's defaults do", () => {
    const tooLong = units().map((unit) => (unit.key === "u2" ? { ...unit, messageCount: IMPORT_MAX_BRANCH_MESSAGES + 1 } : unit));
    expect(nodeOf(analyzeImportLocal({ units: tooLong }), "u2")).toMatchObject({ role: "chapter" });
    const noRoom = units().map((unit) => (unit.key === "u2" ? { ...unit, messageCount: IMPORT_MAX_MESSAGES } : unit));
    expect(nodeOf(analyzeImportLocal({ units: noRoom }), "u2")?.role).toBe("standalone");
  });

  it("refuses what the server refuses, naming the field", () => {
    const many = Array.from({ length: IMPORT_ANALYZE_MAX_UNITS + 1 }, (_, index) => ({ key: `k${index}`, question: "q", answer: "", messageCount: 1 }));
    expect(fieldOf(() => analyzeImportLocal({ units: [] }))).toBe("units");
    expect(fieldOf(() => analyzeImportLocal({ units: many }))).toBe("units");
    expect(fieldOf(() => analyzeImportLocal({ units: [{ key: " ", question: "q", answer: "", messageCount: 1 }] }))).toBe("units[0].key");
    expect(fieldOf(() => analyzeImportLocal({ units: [...units(), { ...units()[0]!, key: " u1 " }] }))).toBe("units[6].key");
    expect(fieldOf(() => analyzeImportLocal({ units: [{ key: "a", question: "q", answer: "", messageCount: -1 }] }))).toBe("units[0].messageCount");
    expect(fieldOf(() => analyzeImportLocal({ units: [{ key: "a", question: "q", answer: "", messageCount: 1, startAt: "yesterday" }] }))).toBe("units[0].startAt");
  });

  it("cuts long texts like the server", () => {
    const long = "長".repeat(IMPORT_ANALYZE_TEXT_RUNES + 20);
    const [unit] = normalizeImportAnalyzeInput({ units: [{ key: " a ", question: long, answer: long, messageCount: 2 }] }).units;
    expect(unit!.key).toBe("a");
    expect(Array.from(unit!.question)).toHaveLength(IMPORT_ANALYZE_TEXT_RUNES);
    expect(unit!.question.endsWith("…")).toBe(true);
  });
});

describe("normalizeImportAnalyzePlan", () => {
  it("fills defaults and keeps optional keys only when sent", () => {
    const plan = normalizeImportAnalyzePlan({ nodes: [{ key: "a", unitKeys: ["a", 3], role: "boss", attachToKey: "" }, null], mode: "spiral" });
    expect(plan).toEqual({
      mode: "tree",
      source: "heuristic",
      summary: "",
      nodes: [
        { key: "a", unitKeys: ["a"], title: "", role: "chapter" },
        { key: "", unitKeys: [], title: "", role: "chapter" },
      ],
    });
    expect(normalizeImportAnalyzePlan(null).nodes).toEqual([]);
  });
});
