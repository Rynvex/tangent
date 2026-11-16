import { normalizeBranchView, normalizeMessage } from "@tangent/client";
import { AssistantMessage, BranchSuggestions, Button, Composer, ForkMarker, MessageActions, TurnPreview, UserMessage } from "@tangent/react";
import { useState } from "react";

/** The F1 conversation components in their states, for the gallery's axe run (fixed demo copy). */

const REPLY = [
  "## 硬碟配置",
  "",
  "| 配法 | 可用空間 | 擴充 |",
  "|---|---|---|",
  "| 4 × 4TB RAIDZ1 | 約 12TB | 要一次換 4 顆 |",
  "| 2 × 8TB mirror | 約 8TB | 再加 2 顆就能擴 |",
  "",
  "重建時間約為 $t = \\frac{C}{r}$。",
  "",
  "```sh",
  "zpool create tank mirror /dev/disk/by-id/ata-WDC_WD80EFZZ-1 /dev/disk/by-id/ata-WDC_WD80EFZZ-2",
  "```",
].join("\n");

const USER = normalizeMessage({ id: "g-u", role: "user", content: "預算內買 4 顆碟做 RAIDZ1 好了，空間比較多。" });
const DONE = normalizeMessage({ id: "g-a", role: "assistant", content: REPLY });
const STOPPED = normalizeMessage({ id: "g-s", role: "assistant", content: "UPS 建議買一台 600VA 以上", meta: { cancelled: true } });
const FAILED = normalizeMessage({ id: "g-e", role: "assistant", status: "error", content: "Turn failed", meta: { error: "429 請求過多" } });
const PENDING = normalizeMessage({ id: "g-p", role: "assistant", status: "pending" });
const FORKS = [
  normalizeBranchView({ lineId: "g-b1", status: "open", unread: 2 }),
  normalizeBranchView({ lineId: "g-b2", status: "merged" }),
];

export function ConversationSamples() {
  const [draft, setDraft] = useState("比較 B2 與 Wasabi 的取回費用");
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <section aria-label="對話元件" className="flex flex-col gap-6 rounded-tg-lg border border-tg-border bg-tg-background p-4">
      <UserMessage message={USER} label="你・#18" actions={<MessageActions text={USER.content} />} />
      <AssistantMessage
        message={DONE}
        label="AI・#19"
        actions={<MessageActions text={DONE.content} onBranch={() => undefined} onNote={() => undefined} />}
        footer={
          <>
            <ForkMarker branches={FORKS} onSelect={() => undefined} />
            <BranchSuggestions
              suggestions={[
                { purpose: "B2 與 Wasabi 的取回費用差異", kind: "investigate" },
                { purpose: "rclone 的 --fast-list 是做什麼的？", kind: "aside" },
              ]}
              onOpen={() => undefined}
            />
          </>
        }
      />
      <AssistantMessage message={STOPPED} label="AI・#21" />
      <AssistantMessage message={FAILED} label="AI・#23" onRetry={() => undefined} />
      <AssistantMessage message={PENDING} label="AI・#25" />
      <Composer value={draft} onValueChange={setDraft} onSend={() => undefined} onBranch={() => undefined} onPreview={() => setPreviewOpen(true)} estimate={{ tokens: 12_400, costUsd: 0.09 }} />
      <Button onClick={() => setPreviewOpen(true)}>打開送出前預覽</Button>
      <TurnPreview open={previewOpen} onOpenChange={setPreviewOpen} lineId="nas" content={draft} lineUsage={{ inputTokens: 33_100, outputTokens: 5_200, costUsd: 0.21 }} />
    </section>
  );
}
