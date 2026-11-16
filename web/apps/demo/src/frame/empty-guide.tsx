import { useUiT, type MessageKey } from "@tangent/react";
import type { ReactNode } from "react";

/** The three tips (F10 §4.4); the emoji is decoration, the title says it in words. */
const TIPS: ReadonlyArray<{ icon: string; title: MessageKey; body: MessageKey }> = [
  { icon: "💡", title: "message.guideSelectTitle", body: "message.guideSelectBody" },
  { icon: "🧠", title: "message.guideMemoTitle", body: "message.guideMemoBody" },
  { icon: "🅿️", title: "message.guideParkTitle", body: "message.guideParkBody" },
];

export interface EmptyGuideProps {
  /** G1: what says which model and reasoning effort the conversation uses, shown above the tips. */
  modelNote?: ReactNode;
}

/** Static tips under an empty conversation's "no messages yet": select to ask, memos with a check, parking a list. */
export function EmptyGuide({ modelNote }: EmptyGuideProps = {}) {
  const t = useUiT();
  const tips = (
    <ul aria-label={t("message.guide")} className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-3">
      {TIPS.map((tip) => (
        <li key={tip.title} className="flex min-w-0 flex-col gap-1 rounded-tg border border-tg-border bg-tg-surface p-3">
          <span aria-hidden className="text-tg-lg leading-none">
            {tip.icon}
          </span>
          <span className="text-tg-sm font-medium text-tg-foreground">{t(tip.title)}</span>
          <span className="text-tg-xs leading-relaxed text-tg-muted">{t(tip.body)}</span>
        </li>
      ))}
    </ul>
  );
  if (!modelNote) return tips;
  return (
    <div className="flex flex-col gap-2.5">
      {modelNote}
      {tips}
    </div>
  );
}
