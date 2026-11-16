// @vitest-environment jsdom
/** B21: the summary bar says the import is waiting out the server's rate limit instead of looking stuck. */
import { buildAssemblyBlueprint, type TangentClient, type TimelineSession } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SummaryBar } from "./summary-bar";

const mock = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
afterEach(cleanup);
afterAll(() => mock.mock.dispose());

const session: TimelineSession = {
  key: "s",
  source: "gemini",
  fileName: "Gemini-Combined.json",
  pickOrder: 0,
  conversation: { id: "s", title: "firebase是什麼?", createdAt: null, updatedAt: null, messages: [{ externalId: "q", role: "user", content: "firebase是什麼?", versions: 1 }], branches: [], skippedBranches: 0 },
};
const blueprint = buildAssemblyBlueprint({ mode: "batch", sessions: [session, { ...session, key: "t" }], edits: {}, options: { title: "", folder: "", tags: [] }, relations: false });

function renderBar(importing: { decompose: boolean; done: number; total: number; waiting?: boolean }) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TangentProvider client={mock as TangentClient} locale="zh-TW">
        <SummaryBar blueprint={blueprint} folder="" tags={0} touch={false} blocked={false} problemsId="p" importing={importing} onBack={() => undefined} onImport={() => undefined} />
      </TangentProvider>
    </QueryClientProvider>,
  );
}

describe("SummaryBar while importing", () => {
  it("counts the imports, and says when it waits for the server", () => {
    renderBar({ decompose: false, done: 1, total: 2 });
    expect(screen.getByRole("button", { name: "匯入中…（2 / 2）" })).toBeInTheDocument();
    cleanup();
    renderBar({ decompose: false, done: 1, total: 2, waiting: true });
    expect(screen.getByRole("button", { name: "伺服器忙碌，稍候重試…（2 / 2）" })).toBeInTheDocument();
  });
});
