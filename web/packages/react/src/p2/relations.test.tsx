import type { Capabilities } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { RelationDialog } from "./relation-dialog";
import { RelationList } from "./relation-list";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup({ readOnly = false, capabilities }: { readOnly?: boolean; capabilities?: (c: Capabilities) => Capabilities } = {}) {
  const scenario = nasScenario();
  if (capabilities) scenario.capabilities = capabilities(scenario.capabilities);
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario });
  clients.push(client);
  const wrapper = tangentWrapper(client, undefined, { locale: "zh-TW" });
  return { client, wrapper };
}

async function chooseTarget(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "連到" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

describe("RelationDialog (C3 without dragging)", () => {
  it("relates a message to a branch of this conversation with a note", async () => {
    const { client, wrapper } = setup();
    const onCreated = vi.fn();
    render(<RelationDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} from={{ lineId: NAS_ROOT_ID, messageId: "nas-m17", label: "主線・#2" }} onCreated={onCreated} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立關聯" });
    expect(within(dialog).getByText("主線・#2")).toBeInTheDocument();
    await chooseTarget("查證・4TB 與 8TB 硬碟的每 TB 成本與保固");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "說明（可留白）" }), "價格決定配法");
    await userEvent.click(within(dialog).getByRole("button", { name: "建立" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const relations = (await client.listRelations(NAS_ROOT_ID)).relations;
    expect(relations[0]).toMatchObject({ fromLineId: NAS_ROOT_ID, fromMessageId: "nas-m17", toLineId: "nas-b3", label: "價格決定配法" });
  });

  it("B15: picks one of four kinds, 相關 by default, and warns what 矛盾 does", async () => {
    const { client, wrapper } = setup();
    render(<RelationDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} from={{ lineId: NAS_ROOT_ID, label: "主線" }} onCreated={vi.fn()} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立關聯" });
    const kinds = within(dialog).getByRole("radiogroup", { name: "種類" });
    expect(within(kinds).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["相關", "支持", "矛盾", "依賴"]);
    expect(within(kinds).getByRole("radio", { name: "相關" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(kinds).getByRole("radio", { name: "矛盾" }));
    expect(within(dialog).getByText(/前提已更新/)).toBeInTheDocument();
    await chooseTarget("查證・4TB 與 8TB 硬碟的每 TB 成本與保固");
    await userEvent.click(within(dialog).getByRole("button", { name: "建立" }));
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations[0]?.relationKind).toBe("contradicts"));
  });

  it("R9 G1: the chosen end and the note start over for another conversation or another start", async () => {
    const { wrapper } = setup();
    const { rerender } = render(<RelationDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} from={{ lineId: NAS_ROOT_ID, label: "主線" }} onCreated={vi.fn()} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立關聯" });
    await chooseTarget("查證・4TB 與 8TB 硬碟的每 TB 成本與保固");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "說明（可留白）" }), "舊的說明");
    rerender(<RelationDialog open onOpenChange={vi.fn()} rootLineId="osaka" from={{ lineId: "osaka", label: "主線" }} onCreated={vi.fn()} />);
    const fresh = await screen.findByRole("dialog", { name: "建立關聯" });
    expect(within(fresh).getByRole("textbox", { name: "說明（可留白）" })).toHaveValue("");
    expect(within(fresh).getByRole("button", { name: "建立" })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers other conversations too, and shows the server's refusal", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "osaka" });
    render(<RelationDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} from={{ lineId: NAS_ROOT_ID, label: "主線" }} onCreated={vi.fn()} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立關聯" });
    await chooseTarget("日本行程：大阪 4 天（其他對話）");
    await userEvent.click(within(dialog).getByRole("button", { name: "建立" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("這兩個地方已經有關聯了。");
  });

  it("asks for the other end first and caps the note", async () => {
    const { wrapper } = setup();
    render(<RelationDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} from={{ lineId: NAS_ROOT_ID, label: "主線" }} onCreated={vi.fn()} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立關聯" });
    expect(within(dialog).getByRole("button", { name: "建立" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("textbox", { name: "說明（可留白）" }));
    await userEvent.paste("字".repeat(201));
    expect(within(dialog).getByText("最多 200 字。")).toBeInTheDocument();
  });
});

describe("RelationList (C3 in the outline; keyboard reachable)", () => {
  it("lists the relations with jumps to both ends, across conversations too", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { fromMessageId: "nas-m17", toLineId: "osaka", label: "同一趟旅行" });
    const onGo = vi.fn();
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={onGo} onAdd={vi.fn()} />, { wrapper });
    const list = await screen.findByRole("region", { name: /^關聯/ });
    const item = await within(list).findByRole("listitem");
    expect(item).toHaveTextContent("同一趟旅行");
    await userEvent.click(within(item).getByRole("button", { name: "前往「日本行程：大阪 4 天（其他對話）」" }));
    expect(onGo).toHaveBeenCalledWith("osaka", undefined);
    await userEvent.click(within(item).getByRole("button", { name: "前往「主線」" }));
    expect(onGo).toHaveBeenLastCalledWith(NAS_ROOT_ID, "nas-m17");
  });

  it("deletes with undo for a while", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "x" });
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "刪除關聯 主線 – 查證・4TB 與 8TB 硬碟的每 TB 成本與保固" }));
    expect(await screen.findByText("已刪除關聯。")).toBeInTheDocument();
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations).toHaveLength(0));
    await userEvent.click(screen.getByRole("button", { name: "復原" }));
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations).toHaveLength(1));
    expect((await client.listRelations(NAS_ROOT_ID)).relations[0]).toMatchObject({ toLineId: "nas-b3", label: "x" });
  });

  it("R9 G3: deleted from the far end (the other conversation's list), the near tree's list drops it too", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { fromLineId: "nas-b3", toLineId: "osaka", label: "跨對話" });
    render(
      <>
        <section aria-label="NAS">
          <RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />
        </section>
        <section aria-label="Osaka">
          <RelationList rootLineId="osaka" onGo={vi.fn()} onAdd={vi.fn()} />
        </section>
      </>,
      { wrapper },
    );
    const nas = screen.getByRole("region", { name: "NAS" });
    const osaka = screen.getByRole("region", { name: "Osaka" });
    expect(await within(nas).findByText("跨對話")).toBeInTheDocument();
    await userEvent.click(await within(osaka).findByRole("button", { name: /^刪除關聯/ }));
    await waitFor(() => expect(within(nas).queryByText("跨對話")).toBeNull());
  });

  it("changes a relation's note in place (改說明): Enter saves, Esc leaves it", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "old" });
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "改說明" }));
    const field = screen.getByRole("textbox", { name: "說明" });
    expect(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "說明" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "改說明" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "說明" }));
    await userEvent.type(screen.getByRole("textbox", { name: "說明" }), "new{Enter}");
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations[0]?.label).toBe("new"));
    expect(await screen.findByText("new")).toBeInTheDocument();
  });

  it("B15: shows a relation's kind and changes it while editing", async () => {
    const { client, wrapper } = setup();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "old", relationKind: "supports" });
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />, { wrapper });
    expect(await screen.findByText("支持")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "改說明" }));
    await userEvent.click(screen.getByRole("radio", { name: "依賴" }));
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations[0]).toMatchObject({ label: "old", relationKind: "depends_on" }));
  });

  it("shows AI's relations dashed, to confirm or remove (= accept / dismiss in the inbox)", async () => {
    const { client, wrapper } = setup();
    await client.discardBranch("nas-b3");
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />, { wrapper });
    const suggested = await screen.findByRole("listitem", { name: /AI 建議・待確認/ });
    await userEvent.click(within(suggested).getByRole("button", { name: "確認" }));
    await waitFor(async () => expect((await client.listRelations(NAS_ROOT_ID)).relations).toHaveLength(1));
  });

  it("adds from a button; a viewer sees the list without writing actions", async () => {
    const onAdd = vi.fn();
    const first = setup();
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={onAdd} />, { wrapper: first.wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "新增關聯" }));
    expect(onAdd).toHaveBeenCalled();
    cleanup();
    const viewer = setup({ readOnly: true });
    await viewer.client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3" });
    render(<RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={onAdd} />, { wrapper: viewer.wrapper });
    await screen.findByRole("listitem");
    await waitFor(() => expect(screen.queryByRole("button", { name: "新增關聯" })).toBeNull());
    expect(screen.queryByRole("button", { name: /^刪除關聯/ })).toBeNull();
  });
});
