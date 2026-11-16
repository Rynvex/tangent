// @vitest-environment jsdom
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyGuide } from "./empty-guide";

afterEach(cleanup);

describe("EmptyGuide (F10 §4.4)", () => {
  it("lists three tips, each with a title and a one-line body, the emoji hidden from screen readers", () => {
    const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TangentProvider client={client} locale="en">
          <EmptyGuide />
        </TangentProvider>
      </QueryClientProvider>,
    );
    const list = screen.getByRole("list", { name: "Getting started" });
    const tips = within(list).getAllByRole("listitem");
    expect(tips).toHaveLength(3);
    expect(tips[0]).toHaveTextContent("Select text to ask about it or open a branch");
    expect(tips[1]).toHaveTextContent("Ask AI to check my understanding");
    expect(tips[2]).toHaveTextContent("Type 1. 2. 3. to park several questions");
    for (const tip of tips) expect(tip.querySelector("[aria-hidden]")?.textContent).toMatch(/\p{Extended_Pictographic}/u);
  });
});
