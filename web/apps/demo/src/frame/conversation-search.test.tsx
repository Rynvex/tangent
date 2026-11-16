// @vitest-environment jsdom
import { TangentError } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationList } from "./conversation-list";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(features: "all" | "c1" = "all") {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario({ features }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider>{children}</ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>
  );
  const onSelect = vi.fn();
  render(<ConversationList current={null} onSelect={onSelect} onNew={() => undefined} onDelete={() => undefined} />, { wrapper });
  return { client, onSelect };
}

/** The search box becomes a combobox once the capabilities say the server searches. */
const serverBox = () => screen.findByRole("combobox", { name: /Search/ });

describe("conversation search (search feature on: the server's GET /search)", () => {
  it("groups the hits and marks the matched text as text, never HTML", async () => {
    setup();
    await userEvent.type(await serverBox(), "zfs");
    const results = await screen.findByRole("listbox", { name: "Search results" });
    const groups = within(results).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Branches", "Messages"]);
    const marks = results.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.textContent?.toLowerCase()).toBe("zfs");
    expect(within(groups[0]!).getAllByRole("option")[0]).toHaveTextContent(/in “家用 NAS 與備份策略”/);
  });

  it("↑ ↓ move the active result, Enter opens it at its message, Esc clears", async () => {
    const { onSelect } = setup();
    const box = await serverBox();
    await userEvent.type(box, "zfs");
    const results = await screen.findByRole("listbox");
    const options = within(results).getAllByRole("option");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(box).toHaveAttribute("aria-activedescendant", options[1]!.id);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(box).toHaveAttribute("aria-activedescendant", options.at(-1)!.id);
    await userEvent.keyboard("{Enter}");
    const last = options.at(-1)!;
    expect(onSelect).toHaveBeenCalledWith(last.getAttribute("data-line-id"), last.getAttribute("data-message-id"));
    await userEvent.keyboard("{Escape}");
    expect(box).toHaveValue("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicking a message result opens its line at that message", async () => {
    const { onSelect } = setup();
    await userEvent.type(await serverBox(), "rclone");
    const option = await screen.findByRole("option", { name: /rclone/ });
    await userEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith("nas", expect.stringMatching(/^nas-m/));
  });

  it("says when the query is too short, when nothing matches, and when the server fails", async () => {
    const { client } = setup();
    const box = await serverBox();
    await userEvent.type(box, "z");
    expect(screen.getByText("Type at least 2 characters.")).toBeInTheDocument();
    await userEvent.type(box, "qqq");
    expect(await screen.findByText("Nothing matches “zqqq”.")).toBeInTheDocument();
    vi.spyOn(client, "search").mockRejectedValue(new TangentError(500, "boom", "internal"));
    await userEvent.clear(box);
    await userEvent.type(box, "zfs");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/The search did not work/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("conversation search: 包含封存", () => {
  it("is off by default; on, it also asks for the archived conversations and labels their hits, and stays on", async () => {
    const { client } = setup();
    const spy = vi.spyOn(client, "search");
    const box = await serverBox();
    await userEvent.type(box, "Proxmox");
    expect(await screen.findByText("Nothing matches “Proxmox”.")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Include archived" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const option = await screen.findByRole("option", { name: /Proxmox/ });
    expect(within(option).getByText("Archived")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ q: "Proxmox", limit: 30, archived: true }, expect.anything());
    expect(box).toHaveFocus();
    cleanup();
    setup();
    await userEvent.type(await serverBox(), "Proxmox");
    expect(screen.getByRole("button", { name: "Include archived" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("option", { name: /Proxmox/ })).toBeInTheDocument();
  });
});

describe("conversation search: accessibility and retry (R5)", () => {
  it("points aria-controls only at a listbox that exists, and announces an empty result", async () => {
    setup();
    const box = await serverBox();
    await userEvent.type(box, "z");
    expect(box).not.toHaveAttribute("aria-controls");
    await userEvent.type(box, "qqq");
    expect(await screen.findByText("Nothing matches “zqqq”.")).toHaveAttribute("role", "status");
    expect(box).not.toHaveAttribute("aria-controls");
    await userEvent.clear(box);
    await userEvent.type(box, "zfs");
    const results = await screen.findByRole("listbox");
    expect(box).toHaveAttribute("aria-controls", results.id);
  });

  it("retries every failed search with one press when both fail", async () => {
    localStorage.setItem("tangent-demo.searchArchived", "1");
    const { client } = setup();
    const spy = vi.spyOn(client, "search").mockRejectedValue(new TangentError(500, "boom", "internal"));
    await userEvent.type(await serverBox(), "zfs");
    const alert = await screen.findByRole("alert");
    const asked = (archived: boolean) => spy.mock.calls.filter(([params]) => Boolean(params.archived) === archived).length;
    await waitFor(() => expect(asked(true)).toBe(1));
    expect(asked(false)).toBe(1);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(asked(false)).toBe(2));
    await waitFor(() => expect(asked(true)).toBe(2));
  });
});

describe("conversation search (search feature off)", () => {
  it("keeps the local title search and never calls the server", async () => {
    const { client } = setup("c1");
    const spy = vi.spyOn(client, "search");
    const box = await screen.findByRole("searchbox", { name: /Search/ });
    await userEvent.type(box, "NAS");
    const section = await screen.findByRole("region", { name: "Search results" });
    await waitFor(() => expect(within(section).getByRole("button", { name: /^家用 NAS/ })).toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });
});
