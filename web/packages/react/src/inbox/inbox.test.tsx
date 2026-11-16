import { TangentError, normalizeSeed, normalizeSuggestion, type Capabilities } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { InboxPanel } from "./inbox-panel";
import { SeedCard } from "./seed-card";
import { SuggestionCard } from "./suggestion-card";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function wrap(node: React.ReactNode, { capabilities, readOnly = false }: { capabilities?: Capabilities; readOnly?: boolean } = {}) {
  const scenario = nasScenario();
  if (capabilities) scenario.capabilities = capabilities;
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario });
  clients.push(client);
  render(node, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
  return client;
}

const seed = (over: Record<string, unknown> = {}) => normalizeSeed({ id: "s1", text: "UPS 要不要買？", anchorMessageId: "m18", status: "open", ...over });
const source = { label: "主線 #3", lineId: "root", messageId: "m18" };

describe("SeedCard (B3, components.md p 10, gap 6)", () => {
  it("open: expand, note and drop, and the source goes to its message", async () => {
    const actions = { onExpand: vi.fn(), onNote: vi.fn(), onDrop: vi.fn(), onGoTo: vi.fn() };
    wrap(<SeedCard seed={seed()} source={source} {...actions} />);
    const card = screen.getByRole("article", { name: "種子：UPS 要不要買？" });
    await userEvent.click(within(card).getByRole("button", { name: "到來源：主線 #3" }));
    expect(actions.onGoTo).toHaveBeenCalledWith("root", "m18");
    // Keyboard: every action is a button in order (expand, note, drop).
    within(card).getByRole("button", { name: "展開成支線" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(actions.onExpand).toHaveBeenCalled();
    await userEvent.tab();
    expect(within(card).getByRole("button", { name: "記進紀要" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(actions.onNote).toHaveBeenCalled();
    await userEvent.tab();
    expect(within(card).getByRole("button", { name: "丟掉「UPS 要不要買？」" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(actions.onDrop).toHaveBeenCalled();
  });

  it("without notes there is no 記進紀要; read-only shows no actions", () => {
    wrap(<SeedCard seed={seed()} source={source} onExpand={() => undefined} onDrop={() => undefined} />);
    expect(screen.queryByRole("button", { name: "記進紀要" })).toBeNull();
    cleanup();
    wrap(<SeedCard seed={seed()} source={source} readOnly onExpand={() => undefined} onNote={() => undefined} onDrop={() => undefined} />);
    expect(screen.queryByRole("button", { name: "展開成支線" })).toBeNull();
  });

  it("expanded, noted and dropped say what happened; an expanded one links to its branch", async () => {
    const onGoTo = vi.fn();
    wrap(
      <>
        <SeedCard seed={seed({ id: "a", status: "expanded", expandedLineId: "b9" })} source={source} onGoTo={onGoTo} />
        <SeedCard seed={seed({ id: "b", status: "noted", text: "記下的" })} source={source} />
        <SeedCard seed={seed({ id: "c", status: "dropped", text: "丟掉的" })} source={source} />
      </>,
    );
    expect(screen.getByText("已展開成支線")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "到支線" }));
    expect(onGoTo).toHaveBeenCalledWith("b9");
    expect(screen.getByText("已記進紀要的「待確認」")).toBeInTheDocument();
    expect(screen.getByText("丟掉的").closest("s")).not.toBeNull();
    expect(screen.getByText("已丟掉")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展開成支線" })).toBeNull();
  });

  it("uses the motion tokens only (reduced motion zeroes them)", () => {
    wrap(<SeedCard seed={seed()} source={source} onExpand={() => undefined} />);
    const html = screen.getByRole("article").outerHTML;
    expect(html).not.toMatch(/animate-/);
    for (const match of html.match(/duration-[^\s"]+/g) ?? []) expect(match).toMatch(/^duration-\(--tg-duration-(fast|normal)\)$/);
  });
});

const suggestion = (over: Record<string, unknown> = {}) =>
  normalizeSuggestion({ id: "g1", kind: "probe", feature: "suggestion_probe", lineId: "b2", status: "open", payload: { reason: "回覆要求了一則測試用的建議。" }, ...over });

describe("SuggestionCard (B5, dashed --tg-suggestion)", () => {
  it("open: kind, target, reason, accept and dismiss by keyboard", async () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    wrap(<SuggestionCard suggestion={suggestion()} target="另一條路・改用雲端備份" onAccept={onAccept} onDismiss={onDismiss} />);
    const card = screen.getByRole("article", { name: "建議：測試建議" });
    expect(card.className).toContain("border-dashed");
    expect(card.className).toContain("border-tg-suggestion");
    expect(within(card).getByText("關於：另一條路・改用雲端備份")).toBeInTheDocument();
    expect(within(card).getByText("回覆要求了一則測試用的建議。")).toBeInTheDocument();
    within(card).getByRole("button", { name: "接受" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("decided states have no buttons; an unknown kind shows its name", () => {
    wrap(
      <>
        <SuggestionCard suggestion={suggestion({ id: "a", status: "accepted" })} target="主線" />
        <SuggestionCard suggestion={suggestion({ id: "b", status: "dismissed" })} target="主線" />
        <SuggestionCard suggestion={suggestion({ id: "c", status: "expired", kind: "group_merge" })} target="主線" />
      </>,
    );
    expect(screen.getByText("已接受")).toBeInTheDocument();
    expect(screen.getByText("已忽略")).toBeInTheDocument();
    expect(screen.getByText("已過期")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "建議：group_merge" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("InboxPanel (待處理: the parking lot and the suggestion inbox)", () => {
  it("lists the seeds with their sources and the suggestions, with their counts", async () => {
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />);
    const parking = await screen.findByRole("region", { name: /^停車場/ });
    await waitFor(() => expect(within(parking).getAllByRole("article")).toHaveLength(3));
    expect(within(parking).getByRole("heading")).toHaveTextContent("停車場3・不花 token");
    expect(within(parking).getByRole("button", { name: "到來源：主線 #3" })).toBeInTheDocument();
    const suggestions = screen.getByRole("region", { name: /^建議/ });
    await waitFor(() => expect(within(suggestions).getAllByRole("article")).toHaveLength(1));
    expect(within(suggestions).getByText(/關於：另一條路・改用雲端備份/)).toBeInTheDocument();
  });

  it("notes and drops a seed in place, and shows what happened", async () => {
    const client = wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />);
    const parking = await screen.findByRole("region", { name: /^停車場/ });
    const ups = await within(parking).findByRole("article", { name: "種子：UPS 要不要買？" });
    await userEvent.click(within(ups).getByRole("button", { name: "記進紀要" }));
    expect(await within(parking).findByText("已記進紀要的「待確認」")).toBeInTheDocument();
    const remote = within(parking).getByRole("article", { name: "種子：NAS 要不要開外網存取？" });
    await userEvent.click(within(remote).getByRole("button", { name: "丟掉「NAS 要不要開外網存取？」" }));
    expect(await within(parking).findByText("已丟掉")).toBeInTheDocument();
    expect((await client.listSeeds(NAS_ROOT_ID)).seeds).toHaveLength(1);
    expect((await client.listNotes(NAS_ROOT_ID)).notes.some((note) => note.text === "UPS 要不要買？" && note.section === "to_confirm")).toBe(true);
  });

  it("names a seed's source with the label stored at parking and links to the line its message is on now (B8.1)", async () => {
    const client = mockClient({ scenario: nasScenario() });
    clients.push(client);
    await client.createSeed("nas-b3", { text: "SMR 要怎麼分辨？", anchorMessageId: "nas-b3-4" });
    render(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const card = await screen.findByRole("article", { name: "種子：SMR 要怎麼分辨？" });
    expect(within(card).getByRole("button", { name: "到來源：查證・4TB 與 8TB 硬碟的每 TB 成本與保固" })).toBeInTheDocument();
  });

  it("keeps each card's own busy state and error when two cards act at once (R7 D1)", async () => {
    const client = mockClient({ scenario: nasScenario() });
    clients.push(client);
    const real = client.dropSeed.bind(client);
    // Each drop waits until the test lets it finish, so both are in flight together whatever the machine's speed.
    const release: Record<string, () => void> = {};
    vi.spyOn(client, "dropSeed").mockImplementation(
      (seedId) =>
        new Promise((resolve, reject) => {
          release[seedId] = () => (seedId === "nas-s1" ? reject(new TangentError(409, "gone", "seed_not_open")) : resolve(real(seedId)));
        }),
    );
    render(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const ups = await screen.findByRole("article", { name: "種子：UPS 要不要買？" });
    const remote = screen.getByRole("article", { name: "種子：NAS 要不要開外網存取？" });
    await userEvent.click(within(ups).getByRole("button", { name: "丟掉「UPS 要不要買？」" }));
    await userEvent.click(within(remote).getByRole("button", { name: "丟掉「NAS 要不要開外網存取？」" }));
    expect(within(ups).getByRole("button", { name: "丟掉「UPS 要不要買？」" })).toHaveAttribute("aria-busy", "true");
    expect(within(remote).getByRole("button", { name: "丟掉「NAS 要不要開外網存取？」" })).toHaveAttribute("aria-busy", "true");
    release["nas-s1"]!();
    expect(await within(ups).findByRole("alert")).toHaveTextContent("這顆種子已經展開、記進紀要或丟掉了。");
    expect(within(remote).getByRole("button", { name: "丟掉「NAS 要不要開外網存取？」" })).toHaveAttribute("aria-busy", "true");
    release["nas-s2"]!();
    expect(await screen.findByText("已丟掉")).toBeInTheDocument();
    expect(within(ups).getByRole("button", { name: "丟掉「UPS 要不要買？」" })).not.toHaveAttribute("aria-busy");
  });

  it("F10: 直接問 hands the seed to the host and shows a refusal on its card", async () => {
    const onAskSeed = vi.fn().mockRejectedValueOnce(new TangentError(409, "full", "branch_limit", { limit: 8 }));
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onAskSeed={onAskSeed} onGoTo={() => undefined} />);
    const ups = await screen.findByRole("article", { name: "種子：UPS 要不要買？" });
    await userEvent.click(within(ups).getByRole("button", { name: "把「UPS 要不要買？」開成支線並直接問 AI" }));
    expect(onAskSeed).toHaveBeenCalledWith(expect.objectContaining({ id: "nas-s1" }));
    expect(await within(ups).findByRole("alert")).toBeInTheDocument();
  });

  it("hands a seed to the host to expand", async () => {
    const onExpandSeed = vi.fn();
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={onExpandSeed} onGoTo={() => undefined} />);
    const ups = await screen.findByRole("article", { name: "種子：UPS 要不要買？" });
    await userEvent.click(within(ups).getByRole("button", { name: "展開成支線" }));
    expect(onExpandSeed).toHaveBeenCalledWith(expect.objectContaining({ id: "nas-s1" }));
  });

  it("accepts a suggestion and keeps it, marked accepted, until the panel closes", async () => {
    const client = wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />);
    const card = await screen.findByRole("article", { name: "建議：測試建議" });
    await userEvent.click(within(card).getByRole("button", { name: "接受" }));
    expect(await screen.findByText("已接受")).toBeInTheDocument();
    expect((await client.listSuggestions(NAS_ROOT_ID)).suggestions).toHaveLength(0);
  });

  it("shows only the parts whose feature is on, and says when a section is empty", async () => {
    const scenario = nasScenario();
    const parkingOnly = { ...scenario.capabilities, features: scenario.capabilities.features.filter((feature) => feature.name !== "suggestions") };
    wrap(<InboxPanel rootLineId="okr" lineId="okr" onExpandSeed={() => undefined} onGoTo={() => undefined} />, { capabilities: parkingOnly });
    const parking = await screen.findByRole("region", { name: /^停車場/ });
    expect(await within(parking).findByText(/沒有停著的念頭/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^建議/ })).toBeNull();
  });

  it("a viewer sees the items but no actions", async () => {
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={() => undefined} onGoTo={() => undefined} />, { readOnly: true });
    await screen.findByRole("article", { name: "種子：UPS 要不要買？" });
    await screen.findByRole("article", { name: "建議：測試建議" });
    expect(screen.queryByRole("button", { name: "展開成支線" })).toBeNull();
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
  });
});

describe("InboxPanel: B9 (F5) — stale branches, the review entry and the new kinds", () => {
  const noop = () => undefined;

  it("lists the branches open too long first, with continue and end-and-bring-back", async () => {
    const onContinueBranch = vi.fn();
    const onEndBranch = vi.fn();
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={noop} onGoTo={noop} onContinueBranch={onContinueBranch} onEndBranch={onEndBranch} />);
    const stale = await screen.findByRole("region", { name: /^開太久的支線/ });
    const card = await within(stale).findByRole("article", { name: "改用雲端備份（Backblaze B2），NAS 只做本地快取" });
    expect(within(card).getByText(/14 則・\d+ 天沒有動/)).toBeInTheDocument();
    const sections = screen.getAllByRole("region").map((region) => region.getAttribute("aria-labelledby") && region.textContent?.slice(0, 3));
    expect(sections[0]).toBe("開太久");
    await userEvent.click(within(card).getByRole("button", { name: "繼續" }));
    expect(onContinueBranch).toHaveBeenCalledWith("nas-b2");
    await userEvent.click(within(card).getByRole("button", { name: "結束並帶回" }));
    expect(onEndBranch).toHaveBeenCalledWith("nas-b2");
  });

  it("links to the review at the bottom while open_loops is on", async () => {
    const onReview = vi.fn();
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={noop} onGoTo={noop} onReview={onReview} />);
    await userEvent.click(await screen.findByRole("button", { name: "回顧所有未完成的事" }));
    expect(onReview).toHaveBeenCalled();
  });

  it("open_loops off: no stale branches and no review entry", async () => {
    const scenario = nasScenario();
    const capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "open_loops" ? { name: "open_loops" as const, enabled: false } : feature)) };
    wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={noop} onGoTo={noop} onReview={vi.fn()} />, { capabilities });
    await screen.findByRole("region", { name: /^停車場/ });
    expect(screen.queryByRole("region", { name: /^開太久的支線/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "回顧所有未完成的事" })).toBeNull();
  });

  it("names the B9 kinds and shows what each proposes", () => {
    const goal = normalizeSuggestion({ id: "g", feature: "goal", kind: "goal_propose", status: "open", payload: { text: "保護照片" } });
    const relation = normalizeSuggestion({ id: "r", feature: "relations", kind: "relation", status: "open", payload: { fromLineId: "a", toLineId: "b", fromTitle: "價格", toTitle: "保固", label: "同一筆預算" } });
    const drift = normalizeSuggestion({ id: "d", feature: "goal", kind: "drift", status: "open", payload: { anchorMessageId: "m", reason: "離題了" } });
    wrap(
      <>
        <SuggestionCard suggestion={goal} target="主線" />
        <SuggestionCard suggestion={relation} target="主線" />
        <SuggestionCard suggestion={drift} target="主線" />
      </>,
    );
    expect(within(screen.getByRole("article", { name: "建議：目標提案" })).getByText("目標：保護照片")).toBeInTheDocument();
    const related = screen.getByRole("article", { name: "建議：關聯" });
    expect(within(related).getByText("價格 – 保固")).toBeInTheDocument();
    expect(within(related).getByText("同一筆預算")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "建議：偏題" })).getByText("離題了")).toBeInTheDocument();
  });

  it("a group suggestion (C2) names its members and conflicts; 檢視… hands it to the host instead of accepting blind", async () => {
    const group = normalizeSuggestion({
      id: "gr",
      feature: "group",
      kind: "group",
      status: "open",
      payload: {
        title: "硬碟選購",
        members: [
          { lineId: "a", purpose: "4TB 與 8TB", ended: true, leaf: "x" },
          { lineId: "b", purpose: "二手企業碟", ended: true, leaf: "y" },
        ],
        conflicts: [{ id: "c1", branch: { lineId: "a", claim: "yes" }, other: { lineId: "b", claim: "no" } }],
      },
    });
    const onReview = vi.fn();
    wrap(<SuggestionCard suggestion={group} target="主線" onReview={onReview} onAccept={vi.fn()} onDismiss={vi.fn()} />);
    const card = screen.getByRole("article", { name: "建議：群組" });
    expect(card).toHaveTextContent("把「4TB 與 8TB」、「二手企業碟」圈成「硬碟選購」");
    expect(card).toHaveTextContent("1 個矛盾待決定");
    expect(within(card).queryByRole("button", { name: "接受" })).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "檢視…" }));
    expect(onReview).toHaveBeenCalled();
  });

  it("the panel hands a group suggestion to the host (onGroupSuggestion)", async () => {
    const onGroupSuggestion = vi.fn();
    const client = wrap(<InboxPanel rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} onExpandSeed={vi.fn()} onGoTo={vi.fn()} onGroupSuggestion={onGroupSuggestion} />);
    await client.discardBranch("nas-b3");
    const cards = await screen.findAllByRole("article", { name: "建議：群組" }, { timeout: 3000 });
    await userEvent.click(within(cards[0]!).getByRole("button", { name: "檢視…" }));
    expect(onGroupSuggestion).toHaveBeenCalledWith(expect.objectContaining({ feature: "group" }));
  });

  it("a fold suggestion (D4) names the chapter, how many messages and the tokens saved", () => {
    const fold = normalizeSuggestion({
      id: "fo",
      feature: "fold",
      kind: "fold",
      status: "open",
      payload: { fromMessageId: "a", toMessageId: "b", fromSeq: 1, toSeq: 15, title: "需求盤點", summary: "結論都已寫進紀要", messageCount: 15, tokensOriginal: 4200, tokensSummary: 1100, jobId: "j" },
    });
    wrap(<SuggestionCard suggestion={fold} target="主線" onAccept={vi.fn()} onDismiss={vi.fn()} />);
    const card = screen.getByRole("article", { name: "建議：折疊" });
    expect(card).toHaveTextContent("建議折疊章節「需求盤點」（15 則），每輪約可省 3.1k token");
    expect(card).toHaveTextContent("結論都已寫進紀要");
    expect(within(card).getByRole("button", { name: "接受" })).toBeInTheDocument();
  });

  it("memory suggestions (D1) say what would be remembered, its kind, importance and source; a consolidation shows both", () => {
    const add = normalizeSuggestion({ id: "me", feature: "memory", kind: "memory", status: "open", payload: { action: "add", kind: "fact", text: "8TB is cheapest per TB", importance: 6, source: { label: "硬碟" } } });
    const merge = normalizeSuggestion({ id: "mc", feature: "memory", kind: "memory_consolidate", status: "open", payload: { action: "conflict", memoryIds: ["a", "b"], texts: ["用 mirror", "用 RAIDZ1"], kind: "decision", text: "改用 RAIDZ1", importance: 7, reason: "r" } });
    wrap(
      <>
        <SuggestionCard suggestion={add} target="主線" onAccept={vi.fn()} onDismiss={vi.fn()} />
        <SuggestionCard suggestion={merge} target="主線" onAccept={vi.fn()} onDismiss={vi.fn()} />
      </>,
    );
    const remembered = screen.getByRole("article", { name: "建議：記憶" });
    expect(remembered).toHaveTextContent("記住：8TB is cheapest per TB");
    expect(remembered).toHaveTextContent("事實・重要性 6");
    expect(remembered).toHaveTextContent("出處：硬碟");
    const consolidate = screen.getByRole("article", { name: "建議：整併記憶" });
    expect(consolidate).toHaveTextContent("兩條互相矛盾，改成一條：改用 RAIDZ1");
    expect(consolidate).toHaveTextContent("原本：用 mirror／用 RAIDZ1");
  });
});

