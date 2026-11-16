/** R11 J3: a memory part whose code cannot be fetched fails in its own place; the form, notes and composer stay. */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { LazyBranchMemoryRecall, LazyMemoryFooter, LazyMemoryRecall } from "./slots";

vi.mock("./branch-memory-recall", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));
vi.mock("./memory-recall", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));
vi.mock("./memory-footer", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The props are never read: the module never loads. */
const unused = <T,>() => ({}) as T;

describe("memory slots (LazyRegion)", () => {
  it("the branch form's recall, the new conversation's recall and the notes' footer each show a small load failure; the rest stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = mockClient();
    render(
      <>
        <p>The composer</p>
        <LazyBranchMemoryRecall {...unused<ComponentProps<typeof LazyBranchMemoryRecall>>()} />
        <LazyMemoryRecall {...unused<ComponentProps<typeof LazyMemoryRecall>>()} />
        <LazyMemoryFooter {...unused<ComponentProps<typeof LazyMemoryFooter>>()} />
      </>,
      { wrapper: tangentWrapper(client, undefined, { locale: "en" }) },
    );
    expect(await screen.findAllByRole("alert")).toHaveLength(3);
    expect(screen.getByText("The composer")).toBeInTheDocument();
    client.mock.dispose();
  });
});
