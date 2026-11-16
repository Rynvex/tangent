/**
 * F14 MiniExpand: a session's time skeleton, not its text. Each stretch:
 * when, "#a–#b・n 輪", its first line, and the regenerations hanging there;
 * a dashed CirclePause row between stretches 30 minutes or more apart
 * ("間隔 2 小時 37 分・可以在這裡切章節"); the ending (Flag) last. Pressing
 * a stretch lists its messages, where a role can be switched (你 ⇄ AI) or a
 * message removed and restored (decision #5: no text editing).
 */
import { describeGap, type ImportEdits, type ImportRole, type MiniExpand as MiniExpandData, type MiniSegment, type ParsedConversation } from "@tangent/client";
import { ArrowLeftRight, ChevronDown, ChevronUp, CirclePause, Flag, GitBranch, Undo2, X } from "lucide-react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import { clockOf } from "./time-format";

export interface MiniExpandProps {
  conversation: ParsedConversation;
  mini: MiniExpandData;
  edits: ImportEdits;
  openSegment: number | null;
  touch: boolean;
  locale: string;
  onOpenSegment: (index: number | null) => void;
  onToggleRole: (externalId: string, role: ImportRole) => void;
  onToggleRemoved: (externalId: string) => void;
}

const range = (segment: MiniSegment) => (segment.from === segment.to ? `#${segment.from}` : `#${segment.from}–#${segment.to}`);

function Messages({ props, segment }: { props: MiniExpandProps; segment: MiniSegment }) {
  const t = useF14T();
  const kept = props.mini.messageCount;
  return (
    <ol className="m-0 ml-6 flex list-none flex-col gap-0.5 rounded-tg-sm border border-tg-border bg-tg-surface p-1">
      {segment.messageIds.map((externalId) => {
        const index = props.conversation.messages.findIndex((message) => message.externalId === externalId);
        const message = props.conversation.messages[index]!;
        const role = props.edits.roles[externalId] ?? message.role;
        const removed = props.edits.removed.has(externalId);
        const other = role === "user" ? "assistant" : "user";
        const lastOne = !removed && kept <= 1;
        return (
          <li key={externalId} className={cx("flex items-center gap-2 px-1", props.touch ? "min-h-10" : "min-h-6.5")}>
            <span className="w-7 shrink-0 font-tg-mono text-tg-xs text-tg-muted">#{index + 1}</span>
            <button
              type="button"
              disabled={removed}
              aria-label={t("import.toggleRoleNamed", { n: index + 1, role: t(`import.role.${role}`), other: t(`import.role.${other}`) })}
              onClick={() => props.onToggleRole(externalId, other)}
              className={cx("inline-flex h-5.5 shrink-0 pointer-coarse:min-h-11 items-center gap-1 rounded-tg-full border border-tg-border-input px-1.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45", role === "user" ? "bg-tg-accent" : "bg-tg-surface")}
            >
              {t(`import.role.${role}`)}
              <ArrowLeftRight aria-hidden className="size-3 text-tg-muted" />
            </button>
            <span className={cx("min-w-0 flex-1 truncate text-tg-xs", removed && "line-through opacity-45")}>
              {message.content.replace(/\s+/g, " ")}
              {removed && <span className="sr-only">{t("import.removedNote")}</span>}
            </span>
            <button
              type="button"
              aria-label={removed ? t("import.restoreMsg", { n: index + 1 }) : t("import.removeMsg", { n: index + 1 })}
              title={lastOne ? t("import.lastOne") : undefined}
              aria-disabled={lastOne || undefined}
              onClick={() => !lastOne && props.onToggleRemoved(externalId)}
              className={cx("grid shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring aria-disabled:opacity-45 pointer-coarse:size-11", props.touch ? "size-8" : "size-5")}
            >
              {removed ? <Undo2 aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function MiniExpand(props: MiniExpandProps) {
  const t = useF14T();
  const { mini, openSegment, touch, locale } = props;
  return (
    <div data-tg-mini-expand="" className={cx("flex flex-col gap-1 border-t border-tg-border bg-tg-surface-sunken py-2 pr-2", touch ? "pl-4" : "pl-6")}>
      {mini.segments.map((segment, index) => {
        const open = openSegment === index;
        return (
          <div key={segment.from} className="flex flex-col gap-1">
            {segment.gapBeforeMs !== null && (
              <p className="m-0 flex items-center gap-1.5 text-tg-xs text-tg-foreground">
                <CirclePause aria-hidden className="size-3.5 shrink-0 text-tg-warning" />
                <span className="shrink-0 font-medium">{t("import.gap", { d: describeGap(segment.gapBeforeMs, locale) })}</span>
                <span aria-hidden className="h-0 min-w-4 flex-1 border-t border-dashed border-tg-warning" />
                <span className="shrink-0 text-tg-muted">{t("import.gapHint")}</span>
              </p>
            )}
            <button
              type="button"
              aria-expanded={open}
              onClick={() => props.onOpenSegment(open ? null : index)}
              className={cx("flex items-center gap-3 rounded-tg-sm px-2 text-left hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-11" : "min-h-7.5", open && "bg-tg-surface")}
            >
              <span className="w-10 shrink-0 font-tg-mono text-tg-xs text-tg-foreground">{segment.start ? clockOf(Date.parse(segment.start)) : "—"}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-tg-mono text-tg-xs text-tg-muted">{t("import.segment", { range: range(segment), turns: segment.turns })}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-foreground">
                  <span className="truncate">{segment.summary}</span>
                  {segment.regenerations > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-tg-muted">
                      <GitBranch aria-hidden className="size-3" />
                      {t("import.regen", { n: segment.regenerations })}
                    </span>
                  )}
                </span>
              </span>
              {open ? <ChevronUp aria-hidden className="size-3.5 shrink-0 text-tg-muted" /> : <ChevronDown aria-hidden className="size-3.5 shrink-0 text-tg-muted" />}
            </button>
            {open && <Messages props={props} segment={segment} />}
          </div>
        );
      })}
      {mini.segments.length === 1 && <p className="m-0 px-2 text-tg-xs text-tg-muted">{t("import.onlyOne")}</p>}
      {mini.ending && (
        <p className="m-0 flex items-start gap-1.5 border-t border-tg-border px-2 pt-1.5 text-tg-xs text-tg-foreground">
          <Flag aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-primary-text" />
          {t("import.ending", { text: mini.ending })}
        </p>
      )}
    </div>
  );
}
