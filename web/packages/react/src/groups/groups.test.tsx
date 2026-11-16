/** C2 (F5 phase 3): the group / combine dialog with per-conflict choices, the selection's actions, the outline's group list. */
import { normalizeSuggestion, type BranchView, type Capabilities } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangentEvents } from "../data/live-hooks";
import { mockClient, tangentWrapper } from "../test-utils";
import { GroupFormDialog } from "./group-form-dialog";
import { GroupList } from "./group-list";
import { SelectionActions } from "./selection-actions";

/** Keeps the cache live with the mock's events, as a host does. */
function Live({ children }: { children: ReactNode }) {
  useTangentEvents();
  return <>{children}</>;
}

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup({ readOnly = false, capabilities }: { readOnly?: boolean; capabilities?: (c: Capabilities) => Capabilities } = {}) {
  const scenario = nasScenario();
  if (capabilities) scenario.capabilities = capabilities(scenario.capabilities);
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario, draftMs: 5 });
  clients.push(client);
  return { client, wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) };
}

async function branchesOf(client: ReturnType<typeof setup>["client"], ...ids: string[]): Promise<BranchView[]> {
  const all = (await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches;
  return ids.map((id) => all.find((branch) => branch.lineId === id)!);
}

describe("GroupFormDialog (C2)", () => {
  it("groups ended branches under a title; the summary starts drafting", async () => {
    const { client, wrapper } = setup();
    const onDone = vi.fn();
    const members = await branchesOf(client, "nas-b5", "nas-b4");
    render(<GroupFormDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} mode="group" members={members} onDone={onDone} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立群組" });
    expect(within(dialog).getByText("用舊筆電當 NAS")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "群組名稱" }), "硬體選擇");
    await userEvent.click(within(dialog).getByRole("button", { name: "建立群組" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect((await client.listGroups(NAS_ROOT_ID)).groups[0]).toMatchObject({ title: "硬體選擇", memberLineIds: ["nas-b5", "nas-b4"] });
  });

  it("combines open siblings into a new branch and says the old ones end", async () => {
    const { client, wrapper } = setup();
    const a = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router A", kind: "investigate" });
    const b = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router B", kind: "investigate" });
    const onDone = vi.fn();
    render(<GroupFormDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} mode="combine" members={[a.branch, b.branch]} onDone={onDone} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "合併成一條支線" });
    expect(dialog).toHaveTextContent("原本的支線會結束，標示「已合併到…」");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /新支線的目的/ }), "Pick the router");
    await userEvent.click(within(dialog).getByRole("button", { name: "合併" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ lineId: expect.any(String) })));
    expect((await client.getBranch(a.line.id)).branch.mergedIntoLineId).toBe(onDone.mock.calls[0]![0].lineId);
  });

  it("an AI proposal's conflicts are chosen one by one (keyboard reachable); keepBoth writes a 待確認 note", async () => {
    const { client, wrapper } = setup();
    await client.discardBranch("nas-b3");
    const proposal = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "group" && (item.payload.conflicts as unknown[]).length > 0)!;
    const members = await branchesOf(client, ...(proposal.payload.members as Array<{ lineId: string }>).map((member) => member.lineId));
    render(<GroupFormDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} mode="group" members={members} suggestion={proposal} onDone={vi.fn()} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "建立群組" });
    expect(within(dialog).getByRole("textbox", { name: "群組名稱" })).toHaveValue("Ended together (fake runner)");
    const conflict = within(dialog).getByRole("radiogroup", { name: /矛盾 1/ });
    await waitFor(() => expect(within(conflict).getAllByRole("radio")).toHaveLength(3));
    await userEvent.click(within(dialog).getByRole("button", { name: "建立群組" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("每個矛盾都要選一個");
    within(conflict).getAllByRole("radio")[0]!.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(within(conflict).getByRole("radio", { name: /都保留/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "建立群組" }));
    await waitFor(async () => expect((await client.listSuggestions(NAS_ROOT_ID, { status: "all" })).suggestions.find((item) => item.id === proposal.id)?.status).toBe("accepted"));
    expect((await client.listNotes(NAS_ROOT_ID)).notes.some((note) => note.section === "to_confirm" && note.text.includes("the first one says yes"))).toBe(true);
  });

  it("without notes there is no keepBoth", async () => {
    const { client, wrapper } = setup({ capabilities: (c) => ({ ...c, features: c.features.map((feature) => (feature.name === "notes" ? { name: "notes", enabled: false } : feature)) }) });
    const members = await branchesOf(client, "nas-b5", "nas-b4");
    const suggestion = normalizeSuggestion({ id: "s", feature: "group", kind: "group", status: "open", payload: { title: "T", members: [], conflicts: [{ id: "c1", branch: { lineId: "nas-b5", claim: "a" }, other: { lineId: "nas-b4", claim: "b" } }] } });
    render(<GroupFormDialog open onOpenChange={vi.fn()} rootLineId={NAS_ROOT_ID} mode="group" members={members} suggestion={suggestion} onDone={vi.fn()} />, { wrapper });
    const conflict = await screen.findByRole("radiogroup", { name: /矛盾 1/ });
    await waitFor(() => expect(within(conflict).getAllByRole("radio")).toHaveLength(2));
  });
});

describe("SelectionActions (multi-select in the outline or map)", () => {
  it("offers the action the selection allows, or says why none", async () => {
    const { client, wrapper } = setup();
    const onAction = vi.fn();
    const ended = await branchesOf(client, "nas-b5", "nas-b4");
    const { rerender } = render(<SelectionActions rootLineId={NAS_ROOT_ID} selected={ended} onAction={onAction} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "建立群組" }));
    expect(onAction).toHaveBeenCalledWith("group");
    rerender(<SelectionActions rootLineId={NAS_ROOT_ID} selected={await branchesOf(client, "nas-b5", "nas-b3")} onAction={onAction} />);
    expect(await screen.findByText("進行中與已結束的支線不能放在一起。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /建立群組|合併/ })).toBeNull();
  });
});

describe("GroupList (the outline's groups)", () => {
  it("shows each group's members and summary; renames, re-summarizes after a failure and dissolves", async () => {
    const { client, wrapper } = setup();
    await client.putLeaf("nas-b5", { kind: "dead_end", line: "[fake:job-error]" });
    const made = await client.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b5", "nas-b4"], title: "硬體" });
    const onGo = vi.fn();
    render(
      <Live>
        <GroupList rootLineId={NAS_ROOT_ID} onGo={onGo} />
      </Live>,
      { wrapper },
    );
    const group = await screen.findByRole("article", { name: "群組：硬體" });
    expect(await within(group).findByText("共同摘要沒寫成（上一次的保留）。")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "前往「另一條路・用舊筆電當 NAS」" }));
    expect(onGo).toHaveBeenCalledWith("nas-b5");
    await userEvent.click(within(group).getByRole("button", { name: "改名" }));
    const field = within(group).getByRole("textbox", { name: "群組名稱" });
    await userEvent.clear(field);
    await userEvent.type(field, "硬碟{Enter}");
    expect(await screen.findByRole("article", { name: "群組：硬碟" })).toBeInTheDocument();
    await client.putLeaf("nas-b5", { kind: "dead_end", line: "only one disk bay" });
    await userEvent.click(within(screen.getByRole("article", { name: "群組：硬碟" })).getByRole("button", { name: "重新寫共同摘要" }));
    await waitFor(async () => expect((await client.getGroup(made.group.id)).group.summaryStatus).toBe("ready"));
    await userEvent.click(within(screen.getByRole("article", { name: "群組：硬碟" })).getByRole("button", { name: "解散群組" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "群組：硬碟" })).toBeNull());
  });

  it("a viewer reads the groups and changes nothing", async () => {
    const { client, wrapper } = setup({ readOnly: true });
    await client.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b5", "nas-b4"], title: "硬體" });
    render(<GroupList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} />, { wrapper });
    const group = await screen.findByRole("article", { name: "群組：硬體" });
    await waitFor(() => expect(within(group).queryByRole("button", { name: "解散群組" })).toBeNull());
    expect(within(group).queryByRole("button", { name: "改名" })).toBeNull();
  });
});
