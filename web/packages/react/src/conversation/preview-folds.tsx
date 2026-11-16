import type { AppliedFold } from "@tangent/client";
import { formatTokens } from "../components/usage-meter";
import { useMessages } from "../data/queries";
import { useP3T } from "../i18n/p3-messages";
import { Section } from "./preview-fisheye";

/** The folds this turn's prompt applies (D4): each range, how many messages it replaced and the tokens it sends instead. */
export function FoldsSection({ folds, lineId }: { folds: readonly AppliedFold[]; lineId: string }) {
  const t = useP3T();
  const messages = useMessages(lineId);
  const chat = (messages.data?.messages ?? []).filter((message) => message.kind === "chat" && message.role !== "system");
  // Each fold's first and last chat number; none until the line's messages are loaded (then the text has no numbers, as FoldBlock).
  const rangeOf = (fold: AppliedFold): { from: number; to: number } | null => {
    const from = chat.findIndex((message) => message.seq >= fold.fromSeq);
    const to = chat.findLastIndex((message) => message.seq <= fold.toSeq);
    return from < 0 || to < from ? null : { from: from + 1, to: to + 1 };
  };
  const itemText = (fold: AppliedFold) => {
    const sizes = { messages: fold.messages, summary: formatTokens(fold.tokensSummary), original: formatTokens(fold.tokensOriginal) };
    const range = rangeOf(fold);
    return range ? t("preview.foldItem", { ...range, ...sizes }) : t("preview.foldItemUnnumbered", sizes);
  };
  return (
    <Section title={t("preview.folds")}>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {folds.map((fold) => (
          <li key={fold.foldId} className="px-1.5 py-1 text-tg-xs text-tg-foreground">
            {itemText(fold)}
          </li>
        ))}
      </ul>
    </Section>
  );
}
