/**
 * F16.1 drop targets of S3 (desktop only; phones use the batch bar):
 * - RoleDropZones, pinned over the preview: 設為主線章節 §, 掛為支線 ↳,
 *   另存成獨立對話. Dragged sessions dropped there take the role; pressed,
 *   one applies to the checked sessions.
 * - ChapterDropTargets on a chapter while something is dragged or checked:
 *   「↳ 掛在 §N 下當支線」 and 「⊕ 合併進 §N」, dropped on or pressed.
 * - StandaloneDrop, the preview's list of separate conversations.
 * While a drag is on they are dashed and tinted; the one under it is ringed.
 */
import type { NodeRole } from "@tangent/client";
import { Bookmark, CornerDownRight, ExternalLink } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import { useAssemblyDnd, type DropTarget } from "./use-assembly-drag";

/** dragover / dragleave / drop of one target, and whether a drag is over it (F17: the mind map's targets too). */
export function useDropTarget(target: DropTarget) {
  const dnd = useAssemblyDnd();
  const [over, setOver] = useState(false);
  const allow = (event: DragEvent<HTMLElement>) => {
    if (!dnd?.isDragging()) return;
    // No stopPropagation: the column under it still sees dragover and scrolls near its edge.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return {
    // A drag cancelled with Esc leaves no ring behind.
    over: over && dnd?.dragging != null,
    props: {
      onDragEnter: allow,
      onDragOver: allow,
      // Moving onto the target's own icon or text is not leaving it.
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        dnd?.drop(target);
      },
    },
  };
}

type ZoneRole = Extract<NodeRole, "chapter" | "merged_branch" | "standalone">;

const ZONES: ReadonlyArray<{ role: ZoneRole; icon: ReactNode; tint: string }> = [
  { role: "chapter", icon: <Bookmark aria-hidden className="size-4" />, tint: "border-tg-primary bg-tg-primary-soft text-tg-primary-text" },
  { role: "merged_branch", icon: <CornerDownRight aria-hidden className="size-4" />, tint: "border-tg-branch-merged bg-[color-mix(in_oklab,var(--tg-branch-merged)_12%,var(--tg-surface))] text-tg-foreground" },
  { role: "standalone", icon: <ExternalLink aria-hidden className="size-4" />, tint: "border-tg-success bg-tg-success-soft text-tg-foreground" },
];

function RoleZone({ role, icon, tint }: (typeof ZONES)[number]) {
  const t = useF14T();
  const dnd = useAssemblyDnd()!;
  const { over, props } = useDropTarget({ kind: "role", role });
  const dragging = dnd.dragging !== null;
  const n = dnd.selection.size;
  const label = t(`f161.drop.${role}`);
  const hint = dragging ? t("f161.dropHint") : n > 0 ? t("f161.dropApply", { n }) : t("f161.dropIdle");
  return (
    <button
      type="button"
      data-tg-drop-role={role}
      aria-label={n > 0 ? t("f161.dropZoneLabel", { label, n }) : t("f161.dropZoneIdle", { label })}
      aria-disabled={(!dragging && n === 0) || undefined}
      onClick={() => {
        if (n > 0) dnd.apply({ kind: "role", role });
      }}
      {...props}
      className={cx(
        "flex min-h-11 min-w-0 flex-col items-start justify-center gap-0.5 rounded-tg border px-2 py-1 text-left transition-[background-color,border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
        dragging || n > 0 ? tint : "border-tg-border bg-tg-surface text-tg-muted",
        dragging && "border-2 border-dashed",
        over && "border-solid ring-2 ring-tg-ring",
        !dragging && n === 0 && "cursor-default",
      )}
    >
      <span className="inline-flex items-center gap-1 text-tg-xs font-semibold">
        {icon}
        {label}
      </span>
      <span className="truncate text-[0.6875rem] text-tg-muted">{hint}</span>
    </button>
  );
}

export function RoleDropZones() {
  const t = useF14T();
  if (!useAssemblyDnd()) return null;
  return (
    <div data-tg-drop-zones="" role="group" aria-label={t("f161.dropZones")} className="sticky top-0 z-20 -mx-0.5 grid grid-cols-3 gap-1.5 bg-tg-surface/95 px-0.5 pb-1.5 backdrop-blur-sm">
      {ZONES.map((zone) => (
        <RoleZone key={zone.role} {...zone} />
      ))}
    </div>
  );
}

function ChapterTarget({ target, label, aria, testId }: { target: DropTarget; label: string; aria: string; testId: Record<string, string> }) {
  const dnd = useAssemblyDnd()!;
  const { over, props } = useDropTarget(target);
  const dragging = dnd.dragging !== null;
  return (
    <button
      type="button"
      {...testId}
      aria-label={aria}
      onClick={() => dnd.apply(target)}
      {...props}
      className={cx(
        "inline-flex h-7 flex-1 items-center justify-center rounded-tg-sm border px-2 text-tg-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring",
        dragging ? "border-2 border-dashed border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent",
        over && "border-solid ring-2 ring-tg-ring",
      )}
    >
      {label}
    </button>
  );
}

/** On chapter §n (`chapterKey`) while other sessions are dragged or checked. */
export function ChapterDropTargets({ chapterKey, chapter, title }: { chapterKey: string; chapter: number; title: string }) {
  const t = useF14T();
  const dnd = useAssemblyDnd();
  if (!dnd) return null;
  const subject = dnd.dragging ?? dnd.selection.ordered;
  // A chapter that is itself dragged or checked takes nothing (the others still offer their targets).
  if (subject.length === 0 || subject.includes(chapterKey)) return null;
  return (
    <div className="flex gap-1.5">
      <ChapterTarget target={{ kind: "attach", chapterKey }} label={t("f161.dropAttach", { n: chapter })} aria={t("f161.dropAttachLabel", { n: chapter, title })} testId={{ "data-tg-drop-attach": chapterKey }} />
      <ChapterTarget target={{ kind: "merge", key: chapterKey }} label={t("f161.dropMerge", { n: chapter })} aria={t("f161.dropMergeLabel", { n: chapter, title })} testId={{ "data-tg-drop-merge": chapterKey }} />
    </div>
  );
}

/** The separate conversations' list (or, while dragging with none yet, a place to drop). */
export function StandaloneDrop({ children }: { children: ReactNode }) {
  const t = useF14T();
  const dnd = useAssemblyDnd();
  const { over, props } = useDropTarget({ kind: "role", role: "standalone" });
  const dragging = dnd?.dragging != null;
  if (!children && !dragging) return null;
  return (
    <div data-tg-drop-standalone-list="" {...(dnd ? props : {})} className={cx("flex flex-col gap-2 rounded-tg", dragging && "border-2 border-dashed border-tg-success p-1.5", over && "border-solid ring-2 ring-tg-ring")}>
      {dragging && <p className="m-0 text-center text-tg-xs text-tg-muted">{t("f161.dropStandaloneList")}</p>}
      {children}
    </div>
  );
}
