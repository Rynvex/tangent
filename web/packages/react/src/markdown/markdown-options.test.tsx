import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadMarkdownRenderer, Markdown, MarkdownOptionsProvider } from "./index";

beforeAll(async () => {
  await loadMarkdownRenderer();
});
afterEach(cleanup);

const CODE = "```sh\nrsync -avh --delete /mnt/tank/photos/ backup@nas.example:/volume1/photos/\n```";
const MATH = "inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$";

/** G2: a host's reader settings reach every Markdown block below the provider. */
describe("MarkdownOptionsProvider: code blocks", () => {
  it("scrolls sideways at the small size without a provider, as ever", () => {
    const { container } = render(<Markdown>{CODE}</Markdown>);
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("overflow-x-auto", "text-tg-sm");
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
    expect(pre).not.toHaveAttribute("data-tg-code-wrap");
  });

  it("wraps long lines when asked to, and stops when asked again, without re-parsing the text", () => {
    const tree = (codeWrap: boolean) => (
      <MarkdownOptionsProvider codeWrap={codeWrap}>
        <Markdown>{CODE}</Markdown>
      </MarkdownOptionsProvider>
    );
    const { container, rerender } = render(tree(true));
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(pre).toHaveAttribute("data-tg-code-wrap", "");
    expect(pre).toHaveAttribute("tabindex", "0");
    rerender(tree(false));
    // The same element: only its classes changed.
    expect(container.querySelector("pre")).toBe(pre);
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
    expect(pre).not.toHaveAttribute("data-tg-code-wrap");
  });

  it("sets the code size from the type scale's tokens", () => {
    const tree = (codeFontSize: "sm" | "md" | "lg") => (
      <MarkdownOptionsProvider codeFontSize={codeFontSize}>
        <Markdown>{CODE}</Markdown>
      </MarkdownOptionsProvider>
    );
    const { container, rerender } = render(tree("lg"));
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("text-tg-md");
    expect(pre).not.toHaveClass("text-tg-sm");
    rerender(tree("sm"));
    expect(pre).toHaveClass("text-tg-xs");
    rerender(tree("md"));
    expect(pre).toHaveClass("text-tg-sm");
  });
});

describe("MarkdownOptionsProvider: math", () => {
  it("leaves dollar signs as written when math is off: no formula, no escaping", async () => {
    const { container } = render(
      <MarkdownOptionsProvider renderMath={false}>
        <Markdown>{MATH}</Markdown>
        <Markdown>{"Rent is $1,200 and food $300; $x$ stays."}</Markdown>
      </MarkdownOptionsProvider>,
    );
    await act(async () => {});
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("[data-tg-math-pending]")).toBeNull();
    expect(container.textContent).toContain("inline $x^2$ and");
    expect(container.textContent).toContain("\\frac{a}{b}");
    expect(container.textContent).toContain("Rent is $1,200 and food $300; $x$ stays.");
  });

  it("shows a ```math block as code when math is off", async () => {
    const { container } = render(
      <MarkdownOptionsProvider renderMath={false}>
        <Markdown>{"```math\n\\frac{a}{b}\n```"}</Markdown>
      </MarkdownOptionsProvider>,
    );
    await act(async () => {});
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("\\frac{a}{b}");
  });

  it("renders formulas again when math is turned back on", async () => {
    const tree = (renderMath: boolean) => (
      <MarkdownOptionsProvider renderMath={renderMath}>
        <Markdown>{MATH}</Markdown>
      </MarkdownOptionsProvider>
    );
    const { container, rerender } = render(tree(false));
    await act(async () => {});
    expect(container.querySelector(".katex")).toBeNull();
    rerender(tree(true));
    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));
  });
});
