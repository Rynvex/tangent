import { isFeatureOn, prepareExcerpt, type MessageSelection } from "@tangent/client";
import { useCapabilities } from "../data/queries";
import { useBranchAndSend } from "../f8/branch-and-send";
import { useUiT } from "../provider";
import { quickAskDraft } from "./ask-templates";

/**
 * ⚡ 秒問解釋 (F10 §2C): no dialog — an aside (an investigate branch while
 * asides are off) from the selection, its default question sent there.
 * The caller goes to the branch; a refusal (a deeper branch to confirm, a
 * limit) is the caller's to show, e.g. by opening the dialog instead.
 */
export function useQuickAsk(lineId: string, options: { /** F18: keep the aside from the start (the conversation's default is 保留); read when asked. */ keepAside?: () => boolean } = {}) {
  const t = useUiT();
  const capabilities = useCapabilities();
  const flow = useBranchAndSend(lineId);
  const kind = isFeatureOn(capabilities.data, "aside") ? "aside" : "investigate";
  const ask = (selection: MessageSelection) => {
    const excerpt = prepareExcerpt(selection.text).text;
    const draft = quickAskDraft(t, excerpt);
    // The question comes back with the outcome: a failed send leaves it for the caller to put in the composer.
    const keep = kind === "aside" && options.keepAside?.() ? { keep: true } : {};
    return flow.run({ purpose: draft.purpose, kind, anchorMessageId: selection.messageId, excerpt, ...keep }, draft.question).then((outcome) => ({ ...outcome, question: draft.question }));
  };
  return { ask, pending: flow.pending };
}
