import type { Capabilities, CapabilityFeature } from "@tangent/client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TangentRoot } from "../root/tangent-root";
import { ShortcutsProvider, useCommand } from "../shortcuts/shortcuts-provider";
import { createTranslator } from "../i18n";
import { SidePanel } from "./side-panel";
import { SideTabs, type SideTabId } from "./side-tabs";
import { sideTabsFor } from "./side-tabs-model";
import { StatusBanner } from "./status-banner";
import { bannerMessage, secondsUntil } from "./status-banner-model";

function caps(...features: CapabilityFeature[]): Capabilities {
  return { features };
}

const CORE_ONLY = caps();
const ALL = caps(
  { name: "notes", enabled: true },
  { name: "parking", enabled: true },
  { name: "open_loops", enabled: true },
  { name: "branch_suggest", enabled: true, mode: "suggest" },
);

describe("sideTabsFor (handoff §9-1)", () => {
  it("shows only 結構 for the core, or before capabilities load", () => {
    expect(sideTabsFor(CORE_ONLY)).toEqual(["structure"]);
    expect(sideTabsFor(null)).toEqual(["structure"]);
  });

  it("adds 紀要 with notes and 待處理 with parking, the suggestion inbox or open loops (DESIGN §12 F0, B8)", () => {
    expect(sideTabsFor(ALL)).toEqual(["structure", "notes", "inbox"]);
    expect(sideTabsFor(caps({ name: "notes", enabled: true }))).toEqual(["structure", "notes"]);
    expect(sideTabsFor(caps({ name: "parking", enabled: true }))).toEqual(["structure", "inbox"]);
    expect(sideTabsFor(caps({ name: "suggestions", enabled: true }))).toEqual(["structure", "inbox"]);
    expect(sideTabsFor(caps({ name: "open_loops", enabled: true }))).toEqual(["structure", "inbox"]);
    // A feature in suggest mode is not the inbox itself: only `suggestions` says whether the inbox exists.
    expect(sideTabsFor(caps({ name: "leaf", enabled: true, mode: "suggest" }))).toEqual(["structure"]);
    expect(sideTabsFor(caps({ name: "parking", enabled: false }, { name: "suggestions", enabled: false }))).toEqual(["structure"]);
  });

  it("keeps the 紀要 tab for memos alone (F10: memos outside focus mode)", () => {
    expect(sideTabsFor(caps({ name: "memo", enabled: true }))).toEqual(["structure", "notes"]);
    expect(sideTabsFor(caps({ name: "memo", enabled: false }))).toEqual(["structure"]);
  });
});

describe("SideTabs", () => {
  const panels = { structure: <p>outline</p>, notes: <p>notes body</p>, inbox: <p>inbox body</p> };

  it("renders a heading instead of tabs when only the core is on", () => {
    render(<SideTabs capabilities={CORE_ONLY} value="notes" onValueChange={vi.fn()} inboxCount={0} panels={panels} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("heading", { name: "Structure" })).toBeInTheDocument();
    expect(screen.getByText("outline")).toBeInTheDocument();
    expect(screen.queryByText("notes body")).toBeNull();
  });

  it("shows the inbox count even when it is 0 and switches panels", async () => {
    const onValueChange = vi.fn<(value: SideTabId) => void>();
    const { rerender } = render(<SideTabs capabilities={ALL} value="structure" onValueChange={onValueChange} inboxCount={0} panels={panels} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Structure", "Notes", "Inbox00 waiting"]);
    await userEvent.click(screen.getByRole("tab", { name: /Inbox/ }));
    expect(onValueChange).toHaveBeenCalledWith("inbox");
    rerender(<SideTabs capabilities={ALL} value="inbox" onValueChange={onValueChange} inboxCount={6} panels={panels} />);
    expect(screen.getByRole("tab", { name: /Inbox/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("inbox body");
    expect(screen.getByRole("tab", { name: /Inbox/ })).toHaveTextContent("6");
  });

  it("falls back to 結構 when the selected tab's feature is turned off", () => {
    render(<SideTabs capabilities={caps({ name: "parking", enabled: true })} value="notes" onValueChange={vi.fn()} inboxCount={1} panels={panels} />);
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Notes" })).toBeNull();
  });

  it("names the tab 備忘 when memos are on and notes are off (F10)", () => {
    render(<SideTabs capabilities={caps({ name: "memo", enabled: true })} value="notes" onValueChange={vi.fn()} inboxCount={0} panels={panels} />);
    expect(screen.getByRole("tab", { name: "Memos" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("notes body");
  });
});

describe("SidePanel", () => {
  it("is a named complementary landmark as a column and renders nothing when closed", () => {
    const { rerender } = render(
      <SidePanel mode="column" open onOpenChange={vi.fn()} label="Side panel">
        content
      </SidePanel>,
    );
    expect(screen.getByRole("complementary", { name: "Side panel" })).toHaveAttribute("data-mode", "column");
    rerender(
      <SidePanel mode="column" open={false} onOpenChange={vi.fn()} label="Side panel">
        content
      </SidePanel>,
    );
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes the overlay on Esc without a shortcut provider (Esc inside the panel)", () => {
    const onOpenChange = vi.fn();
    render(
      <SidePanel mode="overlay" open onOpenChange={onOpenChange} label="Side panel">
        <button type="button">inside</button>
      </SidePanel>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is a modal bottom sheet on phones with a visible close button, closing on Esc", async () => {
    const onOpenChange = vi.fn();
    render(
      <SidePanel mode="sheet" open onOpenChange={onOpenChange} label="Side panel">
        <button type="button">inside</button>
      </SidePanel>,
    );
    const sheet = await screen.findByRole("dialog", { name: "Side panel" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Close the side panel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  function OverlayApp({ onBack }: { onBack: () => void }) {
    const [open, setOpen] = useState(false);
    useCommand("nav.back", onBack);
    return (
      <>
        <button type="button" onClick={() => setOpen(!open)}>
          Outline
        </button>
        <SidePanel mode="overlay" open={open} onOpenChange={setOpen} label="Side panel">
          <button type="button">inside</button>
        </SidePanel>
      </>
    );
  }

  it("closes the overlay on Esc before nav.back runs, and returns focus to its opener (F0 review M6, M7)", async () => {
    const onBack = vi.fn();
    render(
      <TangentRoot>
        <ShortcutsProvider platform="other">
          <OverlayApp onBack={onBack} />
        </ShortcutsProvider>
      </TangentRoot>,
    );
    const opener = screen.getByRole("button", { name: "Outline" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "inside" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("StatusBanner", () => {
  const t = createTranslator("zh-TW");
  const NOW = Date.parse("2026-10-15T12:00:00Z");

  it("counts down to the next retry in whole seconds", () => {
    expect(secondsUntil("2026-10-15T12:00:11.200Z", NOW)).toBe(12);
    expect(secondsUntil(NOW - 5000, NOW)).toBe(0);
    expect(secondsUntil("garbage", NOW)).toBeNull();
    expect(secondsUntil(undefined, NOW)).toBeNull();
  });

  it("words the four states with the prototype's text", () => {
    const aiError = { kind: "aiError", attempt: 2, maxAttempts: 3, nextRetryAt: NOW + 12_000, reason: "429 請求過多" } as const;
    expect(bannerMessage(aiError, NOW, t)).toBe("AI 服務暫時無法使用（429 請求過多）。12 秒後自動重試，第 2 / 3 次；失敗的請求不計費。");
    expect(bannerMessage(aiError, NOW + 13_000, t)).toBe("AI 服務暫時無法使用（429 請求過多）。正在重試，第 2 / 3 次；失敗的請求不計費。");
    expect(bannerMessage({ kind: "reconnecting", attempt: 2, nextRetryAt: NOW + 5000 }, NOW, t)).toBe(
      "連線中斷，正在重新連線…（第 2 次，5 秒後再試）。輸入的內容會保留。",
    );
    expect(bannerMessage({ kind: "readonly" }, NOW, t)).toBe("你只有檢視權限：看得到所有支線與紀要，但不能送出或修改。");
    expect(bannerMessage({ kind: "limit", limit: 200 }, NOW, t)).toBe("整棵對話已有 200 條支線（上限）。結束或獨立一些支線後才能再開新的。");
  });

  it("ticks the visible countdown while the announced text stays stable", () => {
    vi.useFakeTimers();
    try {
      let clock = NOW;
      const { container } = render(<StatusBanner state={{ kind: "aiError", attempt: 1, maxAttempts: 3, nextRetryAt: NOW + 3000 }} now={() => clock} />);
      const bar = container.querySelector("[data-tg-banner]")!;
      expect(bar).toHaveTextContent("Retrying in 3 s");
      const announced = screen.getByRole("alert").textContent;
      clock += 1000;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(bar).toHaveTextContent("Retrying in 2 s");
      expect(screen.getByRole("alert").textContent).toBe(announced);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both live regions mounted and swaps their text (F0 review M11)", () => {
    const { rerender } = render(<StatusBanner state={null} />);
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect([status.textContent, alert.textContent]).toEqual(["", ""]);
    rerender(<StatusBanner state={{ kind: "reconnecting", attempt: 2 }} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Reconnecting… (attempt 2)");
    expect(alert.textContent).toBe("");
    rerender(<StatusBanner state={{ kind: "aiError", attempt: 1, maxAttempts: 3 }} />);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert).toHaveTextContent("The AI service is unavailable");
    expect(status.textContent).toBe("");
    rerender(<StatusBanner state={null} />);
    expect([status.textContent, alert.textContent]).toEqual(["", ""]);
  });

  it("offers the action only when the host handles it, and none for read-only", async () => {
    const onAction = vi.fn();
    const { rerender } = render(<StatusBanner state={{ kind: "reconnecting", attempt: 2 }} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(onAction).toHaveBeenCalledOnce();
    rerender(<StatusBanner state={{ kind: "readonly" }} onAction={onAction} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("You have view access");
    rerender(<StatusBanner state={{ kind: "limit", limit: 200 }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
