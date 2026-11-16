/** R11 J3: a P3 part whose code cannot be fetched fails in its own place; the rest of the transcript stays. */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { LazyArgTag, LazyDivergeMarker, LazyFoldBlock } from "./p3-slots";

vi.mock("../p3/arg-tag", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));
vi.mock("../p3/fold-block", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));
vi.mock("../p3/diverge-marker", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The props are never read: the module never loads. */
const unused = <T,>() => ({}) as T;

describe("P3 slots (LazyRegion)", () => {
  it("the tag, the fold block and the diverge marker each show a small load failure; the messages stay", async () => {
    // React reports the caught errors on the console; keep the run quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = mockClient();
    render(
      <>
        <p>The other messages</p>
        <LazyArgTag {...unused<ComponentProps<typeof LazyArgTag>>()} />
        <LazyFoldBlock {...unused<ComponentProps<typeof LazyFoldBlock>>()} />
        <LazyDivergeMarker {...unused<ComponentProps<typeof LazyDivergeMarker>>()} />
      </>,
      { wrapper: tangentWrapper(client, undefined, { locale: "en" }) },
    );
    expect(await screen.findAllByRole("alert")).toHaveLength(3);
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Could not load this part.");
    expect(screen.getByText("The other messages")).toBeInTheDocument();
    client.mock.dispose();
  });
});
