import { isFeatureOn, type Capabilities } from "@tangent/client";
import { useId, type ReactNode } from "react";
import { Badge } from "../components/display";
import { Tab, Tabs, TabsList, TabsPanel } from "../components/tabs";
import type { MessageKey } from "../i18n";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { isSideTabId, sideTabsFor, type SideTabId } from "./side-tabs-model";

export type { SideTabId } from "./side-tabs-model";

const LABELS: Record<SideTabId, MessageKey> = {
  structure: "sideTabs.structure",
  notes: "sideTabs.notes",
  inbox: "sideTabs.inbox",
};

/** components.md: SideTabs h52. */
const BAR = "flex h-13 shrink-0 items-stretch border-b border-tg-border";

export interface SideTabsProps {
  capabilities: Capabilities | null | undefined;
  value: SideTabId;
  onValueChange: (value: SideTabId) => void;
  /** Items waiting in 待處理; always shown, including 0. */
  inboxCount: number;
  /** The content of each tab; tabs whose feature is off are never rendered. */
  panels: { structure: ReactNode; notes?: ReactNode; inbox?: ReactNode };
  className?: string;
}

/**
 * The side panel's tabs, driven by capabilities (handoff §9-1). With only
 * the core on there is no tab bar, just the heading 結構.
 */
export function SideTabs({ capabilities, value, onValueChange, inboxCount, panels, className }: SideTabsProps) {
  const t = useUiT();
  const headingId = useId();
  const tabs = sideTabsFor(capabilities);
  const selected = tabs.includes(value) ? value : "structure";

  if (tabs.length === 1) {
    return (
      <section aria-labelledby={headingId} className={cx("flex min-h-0 flex-1 flex-col", className)}>
        <h2 id={headingId} className={cx(BAR, "m-0 items-center px-4 text-tg-base font-semibold text-tg-foreground-strong")}>
          {t("sideTabs.structure")}
        </h2>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">{panels.structure}</div>
      </section>
    );
  }

  return (
    <Tabs value={selected} onValueChange={(next) => {
        if (isSideTabId(next)) onValueChange(next);
      }} className={cx("flex min-h-0 flex-1 flex-col", className)}>
      <TabsList aria-label={t("sideTabs.label")} className={cx(BAR, "px-3")}>
        {tabs.map((id) => (
          <Tab key={id} value={id}>
            {/* F10: with notes off the tab holds only the memos; F19: or, without those too, only the glossary. */}
            {t(id === "notes" && !isFeatureOn(capabilities, "notes") ? (isFeatureOn(capabilities, "memo") ? "sideTabs.memos" : "sideTabs.glossary") : LABELS[id])}
            {id === "inbox" && (
              <>
                <Badge aria-hidden>{inboxCount}</Badge>
                <span className="sr-only">{t("sideTabs.inboxCount", { count: inboxCount })}</span>
              </>
            )}
          </Tab>
        ))}
      </TabsList>
      {tabs.map((id) => (
        <TabsPanel key={id} value={id} className="flex flex-col overflow-auto">
          {panels[id]}
        </TabsPanel>
      ))}
    </Tabs>
  );
}
