/**
 * @tangent/client/testing — an in-memory client with the real client's
 * interface, plus scenario fixtures. For demos, component tests and e2e runs
 * without a server; never imported by the library itself.
 */
export { createMockTangentClient, type MockControls, type MockTangentClient, type MockTangentClientOptions } from "./mock-client";
export type { MockTimers } from "./mock-context";
export type { MockState } from "./mock-store";
export { fixture, MOCK_CHAPTER_LIMITS, MOCK_NOTE_LIMITS, type MockChapters, type MockScenario } from "./scenario";
export { mockCapabilities, NAS_ROOT_ID, nasScenario, type MockFeatureSet, type NasScenarioOptions } from "./scenario-nas";
/** B21: combined exports shaped like the user's Gemini folder export (tests and demos). */
export { geminiCombinedSample, longCombinedExport, type CombinedExport } from "../import-combined-fixtures";
/** B22: the A → B → A → C → A → B rounds, as one conversation and as a combined export. */
export { INTERLEAVED_ROUNDS, interleavedCombinedExport, interleavedConversation } from "../import-combined-fixtures";
/** B22: the server's deterministic import analysis, for tests and demos without a server. */
export { analyzeImportLocal } from "../import-analyze-local";
/** F17: the design's nine rounds (§1 #1 #3 #5, branches #2 #6 and #4, a separate #7, §2 #8 #9) as one dated conversation. */
export { MINDMAP_ROUNDS, mindmapConversation } from "../import-mindmap-fixtures";
