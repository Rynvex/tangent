import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { normalizeBranchView, type Note } from "@tangent/client";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageActions, messageActionModel } from "../conversation/message-actions";
import { en } from "../i18n/en";
import { F8_MESSAGES } from "../i18n/f8-messages";
import { mockClient, tangentWrapper } from "../test-utils";
import { useTagMessage } from "../data/p3-hooks";
import { useMessages } from "../data/queries";
import { ArgReviewCard } from "./arg-review-card";
import { InTreeSearchBar } from "./in-tree-search";
import { StaleBadge } from "./stale-badge";

/** The toolbars render their buttons once their message is pointed at (F8 S1): point at every one. */
const armToolbars = () =>
  act(() => {
    for (const bar of document.querySelectorAll("[data-tg-actions]")) bar.parentElement?.dispatchEvent(new Event("pointerenter"));
  });


afterEach(cleanup);

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("the F8 bundle", () => {
  it("has the same keys and slots in all languages, none of the main dictionary's, and no 筆記", () => {
    expect(Object.keys(F8_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(F8_MESSAGES.en).sort());
    expect(Object.keys(F8_MESSAGES.ja).sort()).toEqual(Object.keys(F8_MESSAGES.en).sort());
    for (const [key, text] of Object.entries(F8_MESSAGES.en)) {
      expect(slots(F8_MESSAGES["zh-TW"][key as keyof typeof F8_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(F8_MESSAGES.ja[key as keyof typeof F8_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn(en, key), key).toBe(false);
    }
    for (const text of Object.values(F8_MESSAGES["zh-TW"])) expect(text).not.toContain("筆記");
  });
});

describe("messageActionModel (S1, decision #1)", () => {
  const all = { onBranch: vi.fn(), onPark: vi.fn(), onNote: vi.fn(), onSpinoff: vi.fn(), onRelate: vi.fn(), onFold: vi.fn(), onDiverge: vi.fn(), onRegenerate: vi.fn(), onPin: vi.fn(), onListToSeeds: vi.fn() };

  it("keeps 開支線, 停車 and copy on a reply; the rest by use in the menu", () => {
    const model = messageActionModel({ text: "x", ...all });
    expect(model.primary.map((item) => item.id)).toEqual(["branch", "park"]);
    expect(model.groups.map((group) => group.map((item) => item.id))).toEqual([["regenerate", "diverge"], ["note", "listToSeeds", "spinoff", "relate", "fold"], ["pin"]]);
  });

  it("puts 釘選 in view when parking is off (only the core: three and nothing else)", () => {
    const model = messageActionModel({ text: "x", onBranch: vi.fn(), onPin: vi.fn() });
    expect(model.primary.map((item) => item.id)).toEqual(["branch", "pin"]);
    expect(model.groups).toEqual([]);
  });

  it("keeps 修改並分岔 and 釘選 on the user's message; the first one says why and offers a new conversation", () => {
    const mine = messageActionModel({ text: "x", role: "user", onEditBranch: vi.fn(), onPin: vi.fn(), onMove: vi.fn(), onRelate: vi.fn() });
    expect(mine.primary.map((item) => item.id)).toEqual(["editBranch", "pin"]);
    expect(mine.groups.map((group) => group.map((item) => item.id))).toEqual([["move", "relate"]]);
    const first = messageActionModel({ text: "x", role: "user", editBlocked: true, onAskAgain: vi.fn(), onPin: vi.fn() });
    expect(first.primary[0]).toMatchObject({ id: "editBranch", disabled: true });
    expect(first.groups[0]!.map((item) => item.id)).toEqual(["editBranch", "askAgain"]);
  });
});

describe("MessageActions (S1 states table)", () => {
  it("is one Tab stop with arrows between its buttons; 「更多動作」 opens the menu and focus comes back", async () => {
    const client = mockClient();
    render(<MessageActions text="hi" onBranch={vi.fn()} onPark={vi.fn()} onNote={vi.fn()} onPin={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const bar = screen.getByRole("toolbar", { name: "Message actions" });
    // Nothing inside until the message is pointed at or focused.
    expect(within(bar).queryAllByRole("button")).toEqual([]);
    // Tab reaches the empty box first; its buttons appear and the first one takes focus.
    act(() => bar.focus());
    await waitFor(() => expect(within(bar).getByRole("button", { name: "Open a branch here" })).toHaveFocus());
    expect(within(bar).getAllByRole("button").every((button) => button.tabIndex === -1)).toBe(true);
    await userEvent.keyboard("{ArrowLeft}");
    const more = within(bar).getByRole("button", { name: "More actions" });
    expect(more).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Add to notes" })).toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(more).toHaveFocus());
    client.mock.dispose();
  });

  it("names 將清單存入停車場 with the reply's item count, only for two or more", async () => {
    const client = mockClient();
    const { rerender } = render(<MessageActions text={"1. one\n2. two\n3. three"} onBranch={vi.fn()} onListToSeeds={vi.fn()} />, { wrapper: tangentWrapper(client) });
    armToolbars();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Park list items (3)…" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    rerender(<MessageActions text="No list." onBranch={vi.fn()} onListToSeeds={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /Park list items/ })).toBeNull());
    client.mock.dispose();
  });
});

describe("InTreeSearchBar (S3)", () => {
  it("asks for two characters, groups purposes and messages, places each hit, and Enter jumps", async () => {
    const client = mockClient();
    const onJump = vi.fn();
    render(<InTreeSearchBar rootLineId={NAS_ROOT_ID} rootTitle="家用 NAS" onJump={onJump} onClose={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const box = screen.getByRole("combobox", { name: "Search this conversation" });
    await userEvent.type(box, "Z");
    expect(await screen.findByText("Type at least 2 characters")).toBeInTheDocument();
    await userEvent.type(box, "FS");
    const list = await screen.findByRole("listbox", { name: "Search this conversation" });
    expect(within(list).getByRole("group", { name: "Branch purposes" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "Messages" })).toBeInTheDocument();
    expect(within(list).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onJump).toHaveBeenCalledTimes(1);
    client.mock.dispose();
  });

  it("with search off, searches what is loaded and says so; Esc closes", async () => {
    const scenario = nasScenario();
    scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "search" ? { name: "search", enabled: false } : feature)) };
    const client = mockClient({ scenario });
    const search = vi.spyOn(client, "search");
    const onClose = vi.fn();
    render(<InTreeSearchBar rootLineId={NAS_ROOT_ID} rootTitle="家用 NAS" onJump={vi.fn()} onClose={onClose} />, { wrapper: tangentWrapper(client) });
    await userEvent.type(screen.getByRole("combobox", { name: "Search this conversation" }), "ZFS");
    expect(await screen.findByText(/Only the loaded messages and branch purposes/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    client.mock.dispose();
  });
});

describe("StaleBadge (S12, decision #5)", () => {
  it("shows nothing without a reason; a replaced note shows the badge, its reason, and 知道了 sets it aside", async () => {
    const client = mockClient();
    const branch = normalizeBranchView({ lineId: "nas-b1", parentLineId: NAS_ROOT_ID, rootLineId: NAS_ROOT_ID, status: "merged", cardMessageId: "nas-c1", purpose: "ZFS" });
    window.localStorage.removeItem("tangent:stale-dismissed:v1");
    const wrapper = tangentWrapper(client);
    const { container } = render(<StaleBadge rootLineId={NAS_ROOT_ID} branch={branch} />, { wrapper });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    const notes = (await client.listNotes(NAS_ROOT_ID)).notes;
    const n1 = notes.find((note: Note) => note.sourceLineId === "nas-b1")!;
    await client.supersedeNote(NAS_ROOT_ID, n1.id, { text: "Btrfs RAID1 instead" });
    cleanup();
    render(<StaleBadge rootLineId={NAS_ROOT_ID} branch={branch} onGoToNote={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const badge = await screen.findByRole("button", { name: "ZFS: premise changed" });
    expect(badge.className).toContain("border-tg-warning");
    expect(badge.className).not.toContain("dashed");
    await userEvent.click(badge);
    expect(await screen.findByText(`The note “${n1.text}” it relied on was replaced by “Btrfs RAID1 instead”.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Got it, don’t remind me about these" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "ZFS: premise changed" })).toBeNull());
    client.mock.dispose();
  });
});

describe("ArgReviewCard (S2)", () => {
  it("lists the whole tree's AI drafts, goes to one on its own line, confirms them all and undoes it", async () => {
    const client = mockClient();
    const chat = async (lineId: string) => (await client.listMessages(lineId)).messages.filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done");
    const main = (await chat(NAS_ROOT_ID)).at(-1)!;
    const branch = (await chat("nas-b3")).at(-1)!;
    await client.tagMessage(main.id, { kind: "idea", status: "draft" });
    await client.tagMessage(branch.id, { kind: "con", status: "draft" });
    const write = vi.spyOn(client, "tagMessage");
    const onGoTo = vi.fn();
    render(<ArgReviewCard rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onGoTo={onGoTo} />, { wrapper: tangentWrapper(client) });
    const card = await screen.findByRole("region", { name: "Argument types to review" });
    const drafts = (await client.listTagDrafts(NAS_ROOT_ID)).drafts;
    expect(card).toHaveTextContent(`AI tagged ${drafts.length} messages in this conversation.`);
    expect(card).toHaveTextContent("Branch “");
    await userEvent.click(within(card).getByRole("button", { name: /^Against/ }));
    expect(onGoTo).toHaveBeenCalledWith("nas-b3", branch.id);
    await userEvent.click(within(card).getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Confirmed ${drafts.length} argument types.`));
    expect(write.mock.calls.map(([id, input]) => [id, input.kind, input.status])).toEqual(drafts.map((draft) => [draft.messageId, draft.tag.kind, undefined]));
    expect((await client.listTagDrafts(NAS_ROOT_ID)).drafts).toEqual([]);
    write.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Put ${drafts.length} back as AI drafts.`));
    expect(write.mock.calls.map(([id, input]) => [id, input.status])).toEqual(drafts.map((draft) => [draft.messageId, "draft"]));
    expect((await client.listTagDrafts(NAS_ROOT_ID)).drafts.map((draft) => draft.messageId)).toEqual(drafts.map((draft) => draft.messageId));
    client.mock.dispose();
  });

  it("復原 leaves a type the user changed after 全部確認 as it is", async () => {
    const client = mockClient();
    const main = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done").at(-1)!;
    await client.tagMessage(main.id, { kind: "idea", status: "draft" });
    function Retag() {
      useMessages(NAS_ROOT_ID);
      const tag = useTagMessage(NAS_ROOT_ID);
      return (
        <button type="button" onClick={() => void tag.mutateAsync({ messageId: main.id, kind: "pro" })}>
          retag
        </button>
      );
    }
    render(
      <>
        <Retag />
        <ArgReviewCard rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onGoTo={vi.fn()} />
      </>,
      { wrapper: tangentWrapper(client) },
    );
    const card = await screen.findByRole("region", { name: "Argument types to review" });
    const count = (await client.listTagDrafts(NAS_ROOT_ID)).drafts.length;
    await userEvent.click(within(card).getByRole("button", { name: "Confirm all" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Confirmed"));
    await userEvent.click(screen.getByRole("button", { name: "retag" }));
    await waitFor(async () => expect((await client.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === main.id)?.tag?.kind).toBe("pro"));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Put ${count - 1} back as AI drafts. 1 you changed since were left as they are.`));
    expect((await client.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === main.id)?.tag).toMatchObject({ kind: "pro", status: "confirmed" });
    client.mock.dispose();
  });
});
