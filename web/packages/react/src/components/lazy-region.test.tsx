import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { LazyRegion } from "./lazy-region";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrapper = () => tangentWrapper(mockClient(), undefined, { locale: "en" });

describe("LazyRegion (R5)", () => {
  it("shows a load failure in its own region instead of taking the page down", async () => {
    // React reports the caught error on the console; keep the run quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    const onReload = vi.fn();
    render(
      <>
        <p>The conversation</p>
        <LazyRegion onReload={onReload}>
          <Broken />
        </LazyRegion>
      </>,
      { wrapper: wrapper() },
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this part.");
    expect(screen.getByText("The conversation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("holds the fallback's place while loading, then shows the part", async () => {
    let resolve: (module: { default: () => ReactElement }) => void = () => undefined;
    const Later = lazy(() => new Promise<{ default: () => ReactElement }>((done) => (resolve = done)));
    render(
      <LazyRegion fallback={<div data-testid="placeholder" />}>
        <Later />
      </LazyRegion>,
      { wrapper: wrapper() },
    );
    expect(screen.getByTestId("placeholder")).toBeInTheDocument();
    resolve({ default: () => <p>Loaded</p> });
    expect(await screen.findByText("Loaded")).toBeInTheDocument();
    expect(screen.queryByTestId("placeholder")).toBeNull();
  });
});
