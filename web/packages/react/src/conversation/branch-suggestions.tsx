import type { BranchKind, BranchSuggestion } from "@tangent/client";
import { GitBranch, MessageCircleQuestion, Search, Split, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { IconButton } from "../components/icon-button";
import type { MessageKey } from "../i18n";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

/** The assistant may propose up to three side lines per reply (A12). */
export const MAX_SUGGESTIONS = 3;

export const KIND_KEYS: Record<BranchKind, MessageKey> = {
  aside: "branch.kindAside",
  investigate: "branch.kindInvestigate",
  alternative: "branch.kindAlternative",
};

export const KIND_ICONS: Record<BranchKind, ReactNode> = {
  aside: <MessageCircleQuestion aria-hidden className="size-3" />,
  investigate: <Search aria-hidden className="size-3" />,
  alternative: <Split aria-hidden className="size-3" />,
};

export interface BranchSuggestionsProps {
  suggestions: readonly BranchSuggestion[];
  /** Opens the branch dialog prefilled (F2 builds the dialog). */
  onOpen: (suggestion: BranchSuggestion) => void;
  className?: string;
}

/**
 * AI-suggested branches under a reply (A12, handoff §9-5 "inline hint"):
 * dashed `--tg-suggestion` pills that open nothing until pressed, and a
 * dismiss button. Dismissing is local to this view.
 */
export function BranchSuggestions({ suggestions, onOpen, className }: BranchSuggestionsProps) {
  const t = useUiT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || suggestions.length === 0) return null;
  return (
    <div role="group" aria-label={t("suggest.title")} className={cx("flex flex-wrap items-center gap-1.5 pt-0.5 font-tg-sans", className)}>
      <span className="inline-flex items-center gap-1 text-tg-xs text-tg-suggestion">
        <GitBranch aria-hidden className="size-3" />
        {t("suggest.title")}
      </span>
      {suggestions.slice(0, MAX_SUGGESTIONS).map((suggestion, index) => (
        <button
          key={`${index}-${suggestion.purpose}`}
          type="button"
          data-tg-suggestion=""
          onClick={() => onOpen(suggestion)}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-tg-full border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 text-left text-tg-xs text-tg-foreground hover:border-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11"
        >
          <span className="inline-flex shrink-0 items-center gap-1 text-tg-suggestion">
            {KIND_ICONS[suggestion.kind]}
            {t(KIND_KEYS[suggestion.kind])}
          </span>
          <span className="min-w-0 truncate">{suggestion.purpose}</span>
        </button>
      ))}
      <IconButton label={t("suggest.dismissAll")} icon={<X />} size="sm" tooltip={false} onClick={() => setDismissed(true)} />
    </div>
  );
}
