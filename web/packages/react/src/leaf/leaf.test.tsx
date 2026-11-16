import { TangentError } from "@tangent/client";
import { nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { BranchLeaf } from "./branch-leaf";
import { Leaf } from "./leaf";

afterEach(cleanup);

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function renderLeaf(node: React.ReactNode, locale = "zh-TW") {
  const client = mockClient();
  clients.push(client);
  return render(node, { wrapper: tangentWrapper(client, undefined, { locale }) });
}

describe("Leaf (B1, components.md: one line, icon 12, gap 4)", () => {
  it("shows each kind with its icon colour and names the kind for screen readers", () => {
    renderLeaf(
      <>
        <Leaf leaf={{ kind: "conclusion", line: "ZFS 較成熟", status: "confirmed" }} />
        <Leaf leaf={{ kind: "decision", line: "用 mirror", status: "confirmed" }} />
        <Leaf leaf={{ kind: "answer", line: "每月一次", status: "confirmed" }} />
        <Leaf leaf={{ kind: "dead_end", line: "沒有 ECC", status: "confirmed" }} />
        <Leaf leaf={{ kind: "to_continue", line: "等報價", status: "confirmed" }} />
      </>,
    );
    for (const [kind, label, colour] of [
      ["conclusion", "結論", "text-tg-leaf-conclusion"],
      ["decision", "決定", "text-tg-leaf-decision"],
      ["answer", "答案", "text-tg-leaf-answer"],
      ["dead_end", "死路", "text-tg-leaf-deadend"],
      ["to_continue", "待續", "text-tg-leaf-pending"],
    ] as const) {
      const leaf = document.querySelector(`[data-tg-leaf="${kind}"]`)!;
      expect(leaf.textContent).toContain(`${label}：`);
      expect(leaf.querySelector("svg")?.getAttribute("class")).toContain(colour);
      expect(leaf.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("marks an AI draft with a dashed edge and 「AI 草稿・待你確認」, an auto-mode leaf with 「AI 做的」", () => {
    renderLeaf(
      <>
        <Leaf leaf={{ kind: "dead_end", line: "太貴", status: "draft" }} />
        <Leaf leaf={{ kind: "answer", line: "每月", status: "confirmed", aiDrafted: true }} />
      </>,
    );
    const draft = document.querySelector('[data-tg-leaf="dead_end"]')!;
    expect(draft.getAttribute("data-leaf-state")).toBe("draft");
    expect(draft.className).toContain("border-dashed");
    expect(within(draft as HTMLElement).getByText("AI 草稿・待你確認")).toBeInTheDocument();
    const ai = document.querySelector('[data-tg-leaf="answer"]')!;
    expect(ai.getAttribute("data-leaf-state")).toBe("ai");
    expect(within(ai as HTMLElement).getByText("AI 做的")).toBeInTheDocument();
  });

  it("can show the kind's name and holds no animation (reduced motion has nothing to stop)", () => {
    renderLeaf(<Leaf leaf={{ kind: "decision", line: "用 mirror", status: "confirmed" }} showKind />, "en");
    const leaf = document.querySelector('[data-tg-leaf="decision"]')!;
    expect(within(leaf as HTMLElement).getByText("Decision")).toBeVisible();
    expect(leaf.outerHTML).not.toMatch(/animate-|transition-/);
  });
});

function setupEditor(mode: "manual" | "suggest" | "auto" = "suggest", props: { lineId?: string; readOnly?: boolean } = {}) {
  const scenario = nasScenario();
  scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "leaf" ? { ...feature, mode } : feature)) };
  const client = mockClient({ scenario, draftMs: 5 });
  clients.push(client);
  render(<BranchLeaf lineId={props.lineId ?? "nas-b5"} mode={mode} readOnly={props.readOnly ?? false} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
  return client;
}

describe("BranchLeaf (the ended branch's leaf: edit, confirm, ask AI)", () => {
  it("shows the leaf and edits it: kind, one line, details; Enter in the line saves and confirms", async () => {
    const client = setupEditor();
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    await within(region).findByText("只能接一顆碟、沒有 ECC");
    await userEvent.click(within(region).getByRole("button", { name: "修改" }));
    const form = within(region).getByRole("group", { name: "修改收尾" });
    const line = within(form).getByRole("textbox", { name: /一句話/ });
    expect(line).toHaveFocus();
    await userEvent.click(within(form).getByRole("radio", { name: "決定" }));
    await userEvent.clear(line);
    await userEvent.type(line, "不用舊筆電{Enter}");
    await waitFor(() => expect(within(region).queryByRole("group")).toBeNull());
    expect(await within(region).findByText("不用舊筆電")).toBeInTheDocument();
    expect((await client.getLeaf("nas-b5")).leaf).toMatchObject({ kind: "decision", line: "不用舊筆電", status: "confirmed" });
    expect(within(region).getByRole("button", { name: "修改" })).toHaveFocus();
  });

  it("Esc leaves the form without saving and without reaching the page", async () => {
    setupEditor();
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    await userEvent.click(await within(region).findByRole("button", { name: "修改" }));
    const onKey = vi.fn();
    window.addEventListener("keydown", onKey);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", onKey);
    expect(within(region).queryByRole("group")).toBeNull();
    expect(onKey).not.toHaveBeenCalled();
  });

  it("refuses an empty or over-long line before sending", async () => {
    setupEditor();
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    await userEvent.click(await within(region).findByRole("button", { name: "修改" }));
    const line = within(region).getByRole("textbox", { name: /一句話/ });
    await userEvent.clear(line);
    await userEvent.click(within(region).getByRole("button", { name: "儲存並確認" }));
    expect(within(region).getByText("一句話是必填。")).toBeInTheDocument();
    await userEvent.type(line, "字".repeat(201));
    expect(within(region).getByText("最多 200 字。")).toBeInTheDocument();
    expect(line).toHaveAttribute("aria-invalid", "true");
  });

  it("with no leaf: writes one, or asks AI for a draft that arrives dashed and is confirmed with one press", async () => {
    const client = setupEditor("manual", { lineId: "nas-b3" });
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    expect(await within(region).findByText("這條支線還沒有收尾。")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "寫收尾" })).toBeInTheDocument();
    // useTangentEvents is not mounted here, so the draft is read again explicitly.
    await userEvent.click(within(region).getByRole("button", { name: "請 AI 起草" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("AI 正在起草收尾…");
    await waitFor(async () => expect((await client.getLeaf("nas-b3")).leaf?.status).toBe("draft"));
  });

  it("a failed draft ends the wait and says why, with a retry (B8.1 draftError)", async () => {
    const client = setupEditor("manual", { lineId: "nas-b3" });
    await client.sendMessage("nas-b3", { content: "[fake:error] fail the draft" });
    await waitFor(async () => expect((await client.getLine("nas-b3")).status).not.toBe("thinking"));
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    const ask = await within(region).findByRole("button", { name: "請 AI 起草" });
    // No event stream here: the failure reaches the cache the way leaf.changed would put it there.
    await userEvent.click(ask);
    expect(await within(region).findByRole("status")).toHaveTextContent("AI 正在起草收尾…");
    await waitFor(async () => expect((await client.getLeaf("nas-b3")).draftError).toBeDefined());
    cleanup();
    render(<BranchLeaf lineId="nas-b3" mode="manual" />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const again = await screen.findByRole("region", { name: "這條支線的收尾" });
    expect(await within(again).findByRole("alert")).toHaveTextContent("AI 沒能起草收尾（執行失敗）");
    expect(within(again).queryByRole("status")).toBeNull();
    await userEvent.click(within(again).getByRole("button", { name: "再試一次" }));
    await waitFor(() => expect(within(again).queryByRole("alert")).toBeNull());
  });

  it("confirms a draft as it is", async () => {
    const client = setupEditor("suggest", { lineId: "nas-b3" });
    await client.startLeafDraft("nas-b3");
    await waitFor(async () => expect((await client.getLeaf("nas-b3")).leaf).not.toBeNull());
    cleanup();
    render(<BranchLeaf lineId="nas-b3" mode="suggest" />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    expect(await within(region).findByText("AI 草稿・待你確認")).toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: "確認" }));
    await waitFor(() => expect(within(region).queryByText("AI 草稿・待你確認")).toBeNull());
    expect((await client.getLeaf("nas-b3")).leaf).toMatchObject({ status: "confirmed", aiDrafted: false });
  });

  it("shows the server's field reasons when it refuses the leaf", async () => {
    const client = setupEditor();
    vi.spyOn(client, "putLeaf").mockRejectedValueOnce(new TangentError(422, "bad", "invalid_leaf", { problems: [{ field: "body", message: "is longer than 4000 characters" }] }));
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    await userEvent.click(await within(region).findByRole("button", { name: "修改" }));
    await userEvent.click(within(region).getByRole("button", { name: "儲存並確認" }));
    expect(await within(region).findByText("is longer than 4000 characters")).toBeInTheDocument();
    expect(within(region).getByRole("group", { name: "修改收尾" })).toBeInTheDocument();
  });

  it("is read-only for a viewer: no edit, no draft", async () => {
    setupEditor("suggest", { readOnly: true });
    const region = await screen.findByRole("region", { name: "這條支線的收尾" });
    await within(region).findByText("只能接一顆碟、沒有 ECC");
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
  });
});
