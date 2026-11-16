import { branchPath, branchTitle, type BranchView, type Usage } from "@tangent/client";
import { Breadcrumb, Button, IconButton, ShortcutKeys, useUiT, type BreadcrumbItem, type BreadcrumbSize, type StatusBannerState } from "@tangent/react";
import { Columns2, ListTree, PanelLeft, PanelRight, Settings, TextSearch } from "lucide-react";
import type { ReactNode } from "react";
import type { DemoState } from "./params";
import { UsageControl } from "./usage-control";

/** A14 states forced through `?state=` (prototype parity, screenshots); "normal" follows the real connection. */
export function bannerFor(state: DemoState, loadedAt: number): StatusBannerState | null {
  switch (state) {
    case "reconnecting":
      return { kind: "reconnecting", attempt: 2, nextRetryAt: loadedAt + 5000 };
    case "aiError":
      return { kind: "aiError", attempt: 2, maxAttempts: 3, nextRetryAt: loadedAt + 12_000, reason: "429" };
    case "readonly":
      return { kind: "readonly" };
    case "limit":
      return { kind: "limit", limit: 200 };
    default:
      return null;
  }
}

/** The path from the main line to `lineId`: "主線" first, then each branch's purpose (A2, A4). */
export function pathItems(rootId: string, lineId: string, branches: readonly BranchView[], mainLabel: string, t: Parameters<typeof branchTitle>[1]): BreadcrumbItem[] {
  const main: BreadcrumbItem = { id: rootId, label: mainLabel };
  if (lineId === rootId) return [main];
  return [main, ...branchPath(lineId, branches).map((branch) => ({ id: branch.lineId, label: branchTitle(branch, t), kind: branch.kind }))];
}

export interface HeaderProps {
  path: readonly BreadcrumbItem[];
  pathSize: BreadcrumbSize;
  usage: Usage | null;
  /** The line on screen (F12 S7: the meter's breakdown reads its next turn). */
  lineId?: string | null;
  /** A turn is running there (the meter's level waits). */
  busy?: boolean;
  showListButton: boolean;
  narrow: boolean;
  sideOpen: boolean;
  onNavigate: (lineId: string) => void;
  onOpenList: () => void;
  onToggleSide: () => void;
  onPreview: () => void;
  onSettings: () => void;
  /** The goal capsule (C4) after the path; absent while the goal feature is off. */
  goal?: ReactNode;
  /** The conversation's menu (F7: archive, delete); absent on branches and for viewers. */
  actions?: ReactNode;
  /** 專注 (FOCUS_MODE.md §5): lit while focus mode is on; the side-panel toggle steps aside meanwhile. */
  focus?: { on: boolean; onToggle: () => void };
  /** 對話內搜尋 ⌘F (F8 S3); on phones it lives in the conversation menu instead, when there is one. */
  onSearch?: () => void;
}

/** The 52px conversation header: path, the goal capsule, token meter (opens the send preview), the conversation menu, settings and the side-panel toggle. */
export function Header({ path, pathSize, usage, lineId = null, busy = false, showListButton, narrow, sideOpen, onNavigate, onOpenList, onToggleSide, onPreview, onSettings, goal, actions, focus, onSearch }: HeaderProps) {
  const t = useUiT();
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b border-tg-border bg-tg-background px-3">
      {showListButton && <IconButton label={t("shell.expandList")} icon={<PanelLeft />} onClick={onOpenList} />}
      {path.length > 0 && <Breadcrumb items={path} size={pathSize} onSelect={onNavigate} className="min-w-12" />}
      {goal}
      <span className="flex-1" />
      {usage && <UsageControl lineId={lineId} usage={usage} onPreview={onPreview} narrow={narrow} busy={busy} />}
      {onSearch && (!narrow || !actions) && <IconButton label={t("command.search.inTree")} icon={<TextSearch />} shortcut={<ShortcutKeys command="search.inTree" />} onClick={onSearch} />}
      {focus &&
        (narrow ? (
          <IconButton label={t("shell.focus")} icon={<Columns2 />} pressed={focus.on} shortcut={<ShortcutKeys command="focus.toggle" />} onClick={focus.onToggle} />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={focus.on}
            title={t("command.focus.toggle")}
            icon={<Columns2 aria-hidden className="size-3.5" />}
            className="aria-pressed:bg-tg-primary-soft aria-pressed:text-tg-primary-text"
            onClick={focus.onToggle}
          >
            {t("shell.focus")}
          </Button>
        ))}
      {actions}
      {narrow && !focus?.on && <IconButton label={t("shell.outline")} icon={<ListTree />} pressed={sideOpen} onClick={onToggleSide} />}
      <IconButton label={t("shell.settings")} icon={<Settings />} onClick={onSettings} />
      {!narrow && !focus?.on && <IconButton label={t("command.sidebar.toggle")} icon={<PanelRight />} pressed={sideOpen} shortcut={<ShortcutKeys command="sidebar.toggle" />} onClick={onToggleSide} />}
    </header>
  );
}
