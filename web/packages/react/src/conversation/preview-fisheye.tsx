/**
 * The send preview's budget and fisheye parts (C1, F5 phase 2): how the
 * shared token budget was spent, and — with the fisheye feature on — how
 * much of each message and branch the model sees this turn (完整 / 摘要 /
 * 只有一句收尾 / 看不到) with its score. Levels are words, not only colour.
 */
import { addEnglish, enSettings } from "../i18n";
import { branchTitle, chatNumbers, type FisheyeItem, type FisheyeLevel, type FisheyeReport, type Message, type PromptBudget } from "@tangent/client";
import { Pin } from "lucide-react";
import { useId, type ReactNode } from "react";
import { formatTokens } from "../components/usage-meter";
import { useGroups } from "../data/group-hooks";
import { useFolds } from "../data/fold-query";
import { useP3T } from "../i18n/p3-messages";
import { useBranches, useLine, useMessages } from "../data/queries";
import { useP2T, type P2MessageKey } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { LEVEL_KEYS } from "../p2/fisheye-levels";
import { KIND_KEYS } from "./branch-suggestions";

// The features' English names come with this part (F8: kept out of the main bundle).
addEnglish(enSettings);

/** A chip per level: each its own look and its own word. */
const LEVEL_CHIP: Record<FisheyeLevel, string> = {
  full: "bg-tg-primary-soft text-tg-primary-text",
  summary: "bg-tg-accent text-tg-foreground",
  leaf_only: "border border-dashed border-tg-border-strong text-tg-foreground",
  hidden: "text-tg-muted line-through",
};

/** Owners with their own word; a feature's owner uses the feature's name. */
const OWNER_KEYS: Readonly<Record<string, P2MessageKey>> = {
  core: "budget.owner.core",
  host: "budget.owner.host",
  history: "budget.owner.history",
  fisheye: "budget.owner.fisheye",
};

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5 border-t border-tg-border px-4 py-3">
      <h3 id={headingId} className="m-0 text-tg-xs font-semibold text-tg-muted">
        {title}
      </h3>
      {description && <p className="m-0 text-tg-xs text-tg-subtle">{description}</p>}
      {children}
    </section>
  );
}

/** How the budget was spent: each owner's share in spending order, and what history may take. */
export function BudgetSection({ budget }: { budget: PromptBudget }) {
  const t = useP2T();
  if (budget.total === 0) return null;
  const ownerName = (owner: string) => {
    const key = OWNER_KEYS[owner];
    if (key) return t(key);
    const feature = t(`feature.${owner}` as P2MessageKey);
    return feature === `feature.${owner}` ? owner : feature;
  };
  const percent = Math.min(100, Math.round((budget.used / budget.total) * 100));
  return (
    <Section title={t("budget.title")}>
      <p className="m-0 text-tg-xs text-tg-foreground">{t("budget.used", { used: budget.used.toLocaleString(), total: budget.total.toLocaleString() })}</p>
      <div aria-hidden className="h-1.5 overflow-hidden rounded-tg-full bg-tg-surface-sunken">
        <div className="h-full bg-tg-primary" style={{ width: `${percent}%` }} />
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {budget.shares.map((share) => (
          <li key={share.owner} className="flex items-center gap-2 text-tg-xs">
            <span className="min-w-0 flex-1 truncate text-tg-foreground">{ownerName(share.owner)}</span>
            <span className="font-tg-mono text-tg-muted">{formatTokens(share.tokens)}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-tg-xs text-tg-subtle">{t("budget.historyCap", { tokens: formatTokens(budget.history) })}</p>
    </Section>
  );
}

export function LevelChip({ level }: { level: FisheyeLevel }) {
  const t = useP2T();
  return <span className={cx("shrink-0 rounded-tg-full px-1.5 py-px text-[0.6875rem] font-medium", LEVEL_CHIP[level])}>{t(LEVEL_KEYS[level])}</span>;
}

function ItemRow({ item, name, excerpt, pinned }: { item: FisheyeItem; name: string; excerpt: string; pinned: boolean }) {
  const t = useP2T();
  return (
    <li data-fisheye-level={item.level} className="flex flex-col gap-0.5 rounded-tg-sm px-1.5 py-1">
      <span className="flex min-w-0 items-center gap-1.5 text-tg-xs">
        <span className="shrink-0 font-medium text-tg-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate text-tg-muted">{excerpt}</span>
        <LevelChip level={item.level} />
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-tg-muted">
        {pinned && (
          <span className="inline-flex items-center gap-1 font-medium text-tg-primary-text">
            <Pin aria-hidden className="size-3" />
            {t("fisheye.pinned")}
          </span>
        )}
        <span className="font-tg-mono">{t("fisheye.score", { score: item.score })}</span>
        <span className="font-tg-mono">{t("fisheye.tokens", { tokens: item.tokens })}</span>
      </span>
    </li>
  );
}

/** What the model sees this turn, item by item: this line's messages (oldest first), then other branches by score. */
export function FisheyeSection({ report, lineId }: { report: FisheyeReport; lineId: string }) {
  const t = useP2T();
  const line = useLine(lineId);
  const root = line.data ? (line.data.conversationBranch?.rootLineId ?? line.data.id) : null;
  const messages = useMessages(lineId);
  const outline = useBranches(root, true);
  const byId = new Map<string, Message>((messages.data?.messages ?? []).map((message) => [message.id, message]));
  const numbers = chatNumbers(messages.data?.messages ?? []);
  const branches = new Map((outline.data?.branches ?? []).map((branch) => [branch.lineId, branch]));
  const groups = useGroups(root, report.items.some((item) => item.kind === "group"));
  const folds = useFolds(lineId, report.items.some((item) => item.kind === "fold"));
  const p3 = useP3T();
  const describe = (item: FisheyeItem): { name: string; excerpt: string; pinned: boolean } => {
    if (item.kind === "group") {
      // A group stands for its members (C2): its name and its shared summary.
      const group = groups.data?.groups.find((entry) => entry.id === item.id);
      return { name: t("group.frame", { title: group?.title ?? "" }), excerpt: group?.summary ?? "", pinned: false };
    }
    if (item.kind === "fold") {
      // A fold stands for its messages (D4): its range and its summary.
      const fold = folds.data?.folds.find((entry) => entry.id === item.id);
      if (!fold) return { name: p3("fisheye.foldUnknown"), excerpt: "", pinned: false };
      const from = numbers.get(fold.fromMessageId);
      const to = numbers.get(fold.toMessageId);
      // Without the line's messages there are no numbers: the count instead, as FoldBlock (R11).
      const name = from && to ? p3("fisheye.fold", { from, to }) : p3("fold.titleUnnumbered", { count: fold.messageCount });
      return { name, excerpt: fold.summary, pinned: false };
    }
    if (item.kind === "branch") {
      const branch = branches.get(item.lineId || item.id);
      return { name: branch ? t("notes.sourceBranch", { kind: t(KIND_KEYS[branch.kind]), title: branchTitle(branch, t) }) : t("fisheye.unknownMessage"), excerpt: branch?.leaf?.line ?? branch?.conclusionLine ?? "", pinned: false };
    }
    const message = byId.get(item.id);
    if (!message) return { name: t("fisheye.unknownMessage"), excerpt: "", pinned: false };
    const who = message.kind === "branch_card" ? t("message.card") : message.role === "user" ? t("message.you") : t("message.assistant");
    const n = numbers.get(message.id);
    return { name: n ? t("fisheye.message", { n, who }) : who, excerpt: message.content.replace(/\s+/g, " ").slice(0, 80), pinned: message.pinned };
  };
  return (
    <Section title={t("fisheye.title")} description={t("fisheye.description")}>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {report.items.map((item) => (
          <ItemRow key={`${item.kind}-${item.id}`} item={item} {...describe(item)} />
        ))}
      </ul>
    </Section>
  );
}
