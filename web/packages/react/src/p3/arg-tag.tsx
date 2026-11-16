import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { TAG_KINDS, type Message, type TagKind } from "@tangent/client";
import { useState } from "react";
import { MenuContent, MenuItem } from "../components/menu";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useTagMessage } from "../data/p3-hooks";
import { useF8T } from "../i18n/f8-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { TAG_KIND_KEYS, TAG_TEXT } from "./tag-kinds";

export interface ArgTagProps {
  message: Message;
  rootLineId: string;
  /** The row's name ("AI・#2"), so the controls say whose type it is. */
  who: string;
  className?: string;
}

const BADGE = "inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.75 text-[0.6875rem] leading-none font-medium";
const DRAFT_ACTION =
  "inline-flex h-5.5 items-center rounded-tg-sm px-1.5 text-[0.6875rem] text-tg-primary-text hover:bg-tg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring";

/**
 * A message's argument type (S1, components.md `ArgBadge` / `ArgDraftActions`):
 * nothing without a type (set one from the message's 「⋯」); a confirmed type
 * is a solid badge; AI's draft is dashed with 「待確認」, and hovering or
 * focusing it shows 確認, 改類型… and 移除 (touch screens confirm in the
 * action sheet instead). A viewer sees the name only.
 */
export default function ArgTag({ message, rootLineId, who, className }: ArgTagProps) {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const tag = useTagMessage(rootLineId);
  const [error, setError] = useState<string | null>(null);
  // The actions stay shown while 改類型…'s menu is open: hover and focus have moved into its popup by then.
  const [picking, setPicking] = useState(false);
  const current = message.tag ?? null;
  if (!current) return null;
  const name = t(TAG_KIND_KEYS[current.kind]);
  const draft = current.status === "draft";
  const badge = (
    <span data-tg-arg-badge={current.status} className={cx(BADGE, TAG_TEXT[current.kind], "bg-tg-surface", draft && "border-dashed")}>
      {name}
      {draft && <span className="font-normal text-tg-muted">・{t("ai.draftShort")}</span>}
      {!draft && current.source === "ai" && <span className="font-normal text-tg-muted">・AI</span>}
    </span>
  );
  if (readOnly || !draft) return <span className={cx("inline-flex", className)}>{badge}</span>;
  const save = (kind: TagKind | null) => {
    setError(null);
    tag.mutateAsync({ messageId: message.id, kind }).catch((failure: unknown) => setError(t("arg.failed", { reason: describeError(failure, t, hostErrorText) })));
  };
  return (
    <span data-tag-status="draft" className={cx("group/arg inline-flex flex-wrap items-center gap-0.5", className)}>
      {/* Focusable, so the draft's actions open from the keyboard as from the mouse (focus-within). */}
      <span tabIndex={0} aria-label={`${who}: ${name}・${t("ai.draftShort")}`} className="rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
        {badge}
      </span>
      {/* Touch screens have no hover: their action sheet confirms (decision #8). */}
      <span className={cx("items-center gap-0.5 group-hover/arg:inline-flex group-focus-within/arg:inline-flex pointer-coarse:hidden!", picking ? "inline-flex" : "hidden")}>
        <button type="button" aria-label={t("arg.confirmKind", { kind: name })} disabled={tag.isPending} onClick={() => save(current.kind)} className={DRAFT_ACTION}>
          {t("arg.confirm")}
        </button>
        <MenuPrimitive.Root open={picking} onOpenChange={setPicking}>
          <MenuPrimitive.Trigger aria-label={`${t("arg.changeKind")} (${who})`} className={DRAFT_ACTION}>
            {t("arg.changeKind")}
          </MenuPrimitive.Trigger>
          <MenuContent>
            {TAG_KINDS.filter((kind) => kind !== current.kind).map((kind) => (
              <MenuItem key={kind} onSelect={() => save(kind)}>
                {t(TAG_KIND_KEYS[kind])}
              </MenuItem>
            ))}
          </MenuContent>
        </MenuPrimitive.Root>
        <button type="button" aria-label={`${t("arg.remove")} (${who})`} disabled={tag.isPending} onClick={() => save(null)} className={cx(DRAFT_ACTION, "text-tg-muted hover:bg-tg-accent")}>
          {t("arg.remove")}
        </button>
      </span>
      {error && (
        <span role="alert" className="text-[0.6875rem] text-tg-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

export { ArgTag };
