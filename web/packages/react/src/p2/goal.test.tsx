import type { Capabilities, FeatureMode } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { useTangentEvents } from "../data/live-hooks";
import { GoalCapsule } from "./goal-capsule";

/** The capsule as a page shows it: with the event stream that brings proposals and job failures. */
function WithEvents({ rootLineId = NAS_ROOT_ID }: { rootLineId?: string }) {
  useTangentEvents();
  return <GoalCapsule rootLineId={rootLineId} />;
}

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function withGoalMode(capabilities: Capabilities, mode: FeatureMode): Capabilities {
  return {
    ...capabilities,
    features: capabilities.features.map((feature) => (feature.name !== "goal" ? feature : mode === "off" ? { name: "goal", enabled: false } : { ...feature, enabled: true, mode })),
  };
}

function setup({ mode = "suggest", readOnly = false }: { mode?: FeatureMode; readOnly?: boolean } = {}) {
  const scenario = nasScenario();
  scenario.capabilities = withGoalMode(scenario.capabilities, mode);
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  // Long enough to see the waiting state before the proposal (or its failure) lands.
  const client = mockClient({ scenario, draftMs: 200 });
  clients.push(client);
  const view = () => render(<WithEvents />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
  return { client, view };
}

const GOAL = "在 3 萬元內做出可以撐 5 年、不會因為單一故障而遺失資料的家用儲存與備份";

describe("GoalCapsule (C4)", () => {
  it("shows the goal; opening it reads the whole goal, its source and that AI gets it every turn", async () => {
    const { view } = setup();
    view();
    const capsule = await screen.findByRole("button", { name: `目標：${GOAL}` });
    await userEvent.click(capsule);
    const editor = await screen.findByRole("dialog", { name: "目標" });
    expect(within(editor).getByText(GOAL)).toBeInTheDocument();
    expect(within(editor).getByText("來源：手動")).toBeInTheDocument();
    expect(within(editor).getByText("目標每一輪都會給 AI。")).toBeInTheDocument();
  });

  it("edits with the keyboard: Enter saves (one line), Esc cancels the edit and keeps the editor open", async () => {
    const { view } = setup();
    view();
    await userEvent.click(await screen.findByRole("button", { name: `目標：${GOAL}` }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    await userEvent.click(within(editor).getByRole("button", { name: "修改" }));
    const field = within(editor).getByRole("textbox", { name: "這段對話的目標" });
    expect(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(within(screen.getByRole("dialog", { name: "目標" })).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(editor).getByRole("button", { name: "修改" }));
    const again = within(editor).getByRole("textbox", { name: "這段對話的目標" });
    await userEvent.clear(again);
    await userEvent.type(again, "保護照片{Enter}");
    expect(await screen.findByRole("button", { name: "目標：保護照片" })).toBeInTheDocument();
  });

  it("refuses an empty goal and one over 300 characters", async () => {
    const { view } = setup();
    view();
    await userEvent.click(await screen.findByRole("button", { name: `目標：${GOAL}` }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    await userEvent.click(within(editor).getByRole("button", { name: "修改" }));
    const field = within(editor).getByRole("textbox", { name: "這段對話的目標" });
    await userEvent.clear(field);
    await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));
    expect(within(editor).getByText("先寫下目標。")).toBeInTheDocument();
    await userEvent.click(field);
    await userEvent.paste("字".repeat(301));
    expect(within(editor).getByText("最多 300 字。")).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "儲存" })).toHaveAttribute("aria-disabled", "true");
  });

  it("without a goal: 設定目標, and 讓 AI 提案 brings a proposal that is adopted with one press", async () => {
    const { client, view } = setup();
    await client.deleteGoal(NAS_ROOT_ID);
    view();
    await userEvent.click(await screen.findByRole("button", { name: "設定目標" }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    expect(within(editor).getByText("還沒有目標。")).toBeInTheDocument();
    await userEvent.click(within(editor).getByRole("button", { name: "讓 AI 提案" }));
    expect(await within(editor).findByText("AI 正在提出目標…")).toBeInTheDocument();
    // suggestion.changed (the event stream) reloads the proposals; nothing polls.
    const adopt = await within(editor).findByRole("button", { name: "採用" }, { timeout: 3000 });
    expect(within(editor).getByText("在 3 萬元內完成可撐 5 年的家用儲存，任一硬碟或整台設備故障都不遺失資料")).toBeInTheDocument();
    await userEvent.click(adopt);
    expect(await screen.findByRole("button", { name: "目標：在 3 萬元內完成可撐 5 年的家用儲存，任一硬碟或整台設備故障都不遺失資料" })).toBeInTheDocument();
  });

  it("stops waiting when the proposal job fails (job.failed) and says why", async () => {
    const { client, view } = setup();
    await client.deleteGoal(NAS_ROOT_ID);
    await client.sendMessage(NAS_ROOT_ID, { content: "[fake:job-error] hmm" });
    for (let i = 0; i < 300 && (await client.getLine(NAS_ROOT_ID)).status === "thinking"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    view();
    await userEvent.click(await screen.findByRole("button", { name: /^設定目標/ }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    await userEvent.click(within(editor).getByRole("button", { name: "讓 AI 提案" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("AI 沒能提出目標（執行失敗）");
    expect(within(editor).queryByText("AI 正在提出目標…")).toBeNull();
    expect(within(editor).getByRole("button", { name: "讓 AI 提案" })).toBeEnabled();
  });

  it("an AI proposal never opens the editor or takes focus: the capsule only marks it", async () => {
    const { client, view } = setup();
    await client.deleteGoal(NAS_ROOT_ID);
    await client.proposeGoal(NAS_ROOT_ID);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    view();
    expect(await screen.findByText("AI 提了一個目標")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("clears the goal", async () => {
    const { view } = setup();
    view();
    await userEvent.click(await screen.findByRole("button", { name: `目標：${GOAL}` }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "目標" })).getByRole("button", { name: "清除目標" }));
    expect(await screen.findByRole("button", { name: "設定目標" })).toBeInTheDocument();
  });

  it("manual mode has the button too; auto mode marks an AI-written goal 「AI 做的」", async () => {
    const { client, view } = setup({ mode: "auto" });
    await client.deleteGoal(NAS_ROOT_ID);
    await client.proposeGoal(NAS_ROOT_ID);
    await new Promise((resolve) => setTimeout(resolve, 260));
    view();
    await userEvent.click(await screen.findByRole("button", { name: /^目標：/ }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    expect(within(editor).getByText("AI 做的")).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "修改" })).toBeInTheDocument();
  });

  it("a viewer reads the goal and changes nothing", async () => {
    const { view } = setup({ readOnly: true });
    view();
    await userEvent.click(await screen.findByRole("button", { name: `目標：${GOAL}` }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    for (const name of ["修改", "清除目標", "讓 AI 提案"]) expect(within(editor).queryByRole("button", { name })).toBeNull();
  });

  it("is not rendered while the goal feature is off", async () => {
    const { client, view } = setup({ mode: "off" });
    view();
    await waitFor(() => expect(client).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(screen.queryByRole("button", { name: /目標/ })).toBeNull();
  });

  it("R9 G1: switching conversations while editing drops the draft and the wait; nothing is saved to the new one", async () => {
    const { client } = setup();
    const wrapper = tangentWrapper(client, undefined, { locale: "zh-TW" });
    const { rerender } = render(<WithEvents />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: `目標：${GOAL}` }));
    const editor = await screen.findByRole("dialog", { name: "目標" });
    await userEvent.click(within(editor).getByRole("button", { name: "修改" }));
    await userEvent.clear(within(editor).getByRole("textbox", { name: "這段對話的目標" }));
    await userEvent.type(within(editor).getByRole("textbox", { name: "這段對話的目標" }), "NAS 的草稿");
    rerender(<WithEvents rootLineId="rust" />);
    const other = await screen.findByRole("button", { name: /^設定目標/ });
    expect(screen.queryByRole("dialog", { name: "目標" })).toBeNull();
    await userEvent.click(other);
    const fresh = await screen.findByRole("dialog", { name: "目標" });
    expect(within(fresh).queryByDisplayValue("NAS 的草稿")).toBeNull();
    expect(within(fresh).queryByText("AI 正在提出目標…")).toBeNull();
    expect((await client.getGoal("rust")).goal).toBeNull();
  });

  it("R9 G1: a proposal asked for in one conversation does not leave the next one waiting", async () => {
    const { client } = setup();
    await client.deleteGoal(NAS_ROOT_ID);
    const wrapper = tangentWrapper(client, undefined, { locale: "zh-TW" });
    const { rerender } = render(<WithEvents />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: /^設定目標/ }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "目標" })).getByRole("button", { name: "讓 AI 提案" }));
    expect(await screen.findByText("AI 正在提出目標…")).toBeInTheDocument();
    rerender(<WithEvents rootLineId="rust" />);
    await userEvent.click(await screen.findByRole("button", { name: /^設定目標/ }));
    const fresh = await screen.findByRole("dialog", { name: "目標" });
    expect(within(fresh).queryByText("AI 正在提出目標…")).toBeNull();
    expect(within(fresh).getByRole("button", { name: "讓 AI 提案" })).toBeEnabled();
  });
});

