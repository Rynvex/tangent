// Markdown renderer component); mermaid,
// diff blocks and upload images are not part of Tangent.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer, Markdown } from "./index";

beforeAll(async () => {
  await loadMarkdownRenderer();
});
afterEach(cleanup);

describe("Markdown basics", () => {
  it("renders headings, lists and GFM tables inside a focusable horizontal scroller", () => {
    const { container } = render(<Markdown>{"## Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);
    expect(container.querySelector("h2")?.textContent).toBe("Plan");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const table = container.querySelector("table");
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
    expect(table?.parentElement).toHaveAttribute("tabindex", "0");
  });

  it("renders task list checkboxes as disabled", () => {
    render(<Markdown>{"- [x] done\n- [ ] todo"}</Markdown>);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeDisabled();
  });

  it("demotes headings one level in the message variant only", () => {
    const { container, rerender } = render(<Markdown variant="message">{"# Title"}</Markdown>);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Title");
    rerender(<Markdown>{"# Title"}</Markdown>);
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("shows inline code without a frame", () => {
    const { container } = render(<Markdown>{"use `go test`"}</Markdown>);
    expect(container.querySelector("code")?.textContent).toBe("go test");
    expect(container.querySelector("[data-tg-code]")).toBeNull();
  });
});

describe("Markdown code blocks", () => {
  it("shows the language label and highlights known languages", async () => {
    const { container } = render(<Markdown>{"```go\nfunc main() { return 1 }\n```"}</Markdown>);
    expect(screen.getByText("go")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
  });

  it("scrolls long lines sideways in a focusable block (review §2 #2)", () => {
    const { container } = render(<Markdown>{"```sh\nrsync -avh --delete /mnt/tank/photos/ backup@nas.example:/volume1/photos/\n```"}</Markdown>);
    const pre = container.querySelector("pre")!;
    expect(pre.className).toContain("overflow-x-auto");
    expect(pre).toHaveAttribute("tabindex", "0");
  });

  it("falls back to plain text for unknown languages", () => {
    const { container } = render(<Markdown>{"```nonsense\nabc\n```"}</Markdown>);
    expect(container.querySelector("pre code")?.textContent).toBe("abc");
    expect(container.querySelector(".hljs-keyword")).toBeNull();
  });

  it("copies the code and briefly shows the copied label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown>{"```sh\nls -la\n```"}</Markdown>);
    const button = screen.getByRole("button", { name: "Copy code" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledWith("ls -la");
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });

  it("reports a failed copy", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<Markdown>{"```sh\nls\n```"}</Markdown>);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(screen.getByText("Copy failed")).toBeInTheDocument());
  });

  it("renders a long single line and a 100k-character block without highlighting it", () => {
    const longLine = "x".repeat(5_000);
    const huge = `${"line of code\n".repeat(8_000)}`;
    const started = performance.now();
    const { container } = render(<Markdown>{`\`\`\`js\n${longLine}\n\`\`\`\n\n\`\`\`js\n${huge}\`\`\``}</Markdown>);
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("renders an unclosed fence as code", () => {
    const { container } = render(<Markdown>{"before\n```js\nconst a = 1"}</Markdown>);
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1");
  });
});

describe("Markdown links and images", () => {
  it("opens allowed links in a new tab with noopener", () => {
    render(<Markdown>{"[ok](https://example.com) [mail](mailto:a@b.co)"}</Markdown>);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it.each(["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html;base64,PHNjcmlwdD4=)", "[x](vbscript:msgbox)", "[x](/relative)"])(
    "does not make a link out of %s",
    (source) => {
      render(<Markdown>{source}</Markdown>);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.getByText("x")).toBeInTheDocument();
    },
  );

  it("never loads an image: safe sources become links, others text", () => {
    const { container } = render(<Markdown>{"![ext](https://evil.example/x.png)\n\n![d](data:image/png;base64,AAAA)"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "ext" })).toHaveAttribute("href", "https://evil.example/x.png");
    expect(screen.getByText("d")).toBeInTheDocument();
  });

  it("does not render raw HTML", () => {
    const { container } = render(<Markdown>{'<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned = 1">\n\n<b>bold</b>'}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("Markdown math", () => {
  it("renders inline and display formulas with KaTeX", async () => {
    const { container } = render(<Markdown>{"inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$"}</Markdown>);
    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("does not treat prices as formulas", async () => {
    const { container } = render(<Markdown>{"It costs $5 and $10, or $5-$10."}</Markdown>);
    expect(container.textContent).toBe("It costs $5 and $10, or $5-$10.");
    await act(async () => {});
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("[data-tg-math-pending]")).toBeNull();
  });

  it("does not make links or images out of \\href, \\url and \\includegraphics", async () => {
    const { container } = render(<Markdown>{"$\\href{javascript:alert(1)}{x}$\n\n$\\url{https://evil.example}$\n\n$\\includegraphics{https://evil.example/a.png}$"}</Markdown>);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/href=/i);
  });

  it("shows the source when a formula is invalid", async () => {
    const { container } = render(<Markdown>{"$$\\notacommand{1}$$"}</Markdown>);
    await waitFor(() => expect(container.querySelector("[data-tg-math-error]")).toHaveTextContent("\\notacommand{1}"));
  });

  it("keeps a formula that is still being typed as code while streaming", () => {
    const { container } = render(<Markdown isStreaming>{"before\n$$\n\\frac{a}{b"}</Markdown>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("frac{a}{b");
  });
});

describe("Markdown memoisation", () => {
  it("renders 200 messages and re-renders the list quickly when one is appended", () => {
    const messages = Array.from({ length: 200 }, (_, index) => `**message ${index}**\n\n- item\n- \`code\`\n\n| a | b |\n|---|---|\n| ${index} | 2 |`);
    const view = (list: string[]) => (
      <div>
        {list.map((text, index) => (
          <Markdown key={index} variant="message">
            {text}
          </Markdown>
        ))}
      </div>
    );
    const initialStart = performance.now();
    const { rerender, container } = render(view(messages));
    const initialMs = performance.now() - initialStart;
    const appendStart = performance.now();
    rerender(view([...messages, "**one more**"]));
    const appendMs = performance.now() - appendStart;
    expect(container.querySelectorAll("table")).toHaveLength(200);
    expect(appendMs).toBeLessThan(initialMs / 4);
  });
});
