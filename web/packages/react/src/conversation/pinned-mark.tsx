import { isFeatureOn } from "@tangent/client";
import { Pin } from "lucide-react";
import { useCapabilities } from "../data/queries";
import { useUiT } from "../provider";

/**
 * 「已釘選」 next to a message's label (B9, core). With fisheye on, a pinned
 * message is always sent whole, and the mark says so (C1); without it the
 * pin does not change the prompt, so it only says 「已釘選」.
 */
export function PinnedMark() {
  const t = useUiT();
  const capabilities = useCapabilities();
  const sent = isFeatureOn(capabilities.data, "fisheye");
  return (
    <span data-tg-pinned="" className="inline-flex items-center gap-1 font-tg-sans text-tg-xs font-medium text-tg-primary-text">
      <Pin aria-hidden className="size-3" />
      {sent ? t("message.pinnedSent") : t("message.pinned")}
    </span>
  );
}
