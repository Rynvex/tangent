import { normalizeBranchPack, normalizeBranchView, normalizeMessage } from "@tangent/client";
import { BranchBar, BranchCard, BranchMap, BranchResultBar, Breadcrumb, ForkMarker, KindRadio, OutlineTree } from "@tangent/react";
import { useState } from "react";

/** The F2 branch components in their states, for the gallery's axe run (fixed demo copy). */

const PARENT = [
  normalizeMessage({ id: "g-m16", seq: 16, role: "user", content: "需求大概清楚了：現有 2.1TB，每年長 400GB，預算 3 萬。硬碟要怎麼配？" }),
  normalizeMessage({ id: "g-m17", seq: 17, role: "assistant", content: "以 5 年估算，總量約 4.1TB；兩者都容許壞一顆碟。" }),
  normalizeMessage({ id: "g-m18", seq: 18, role: "user", content: "預算內買 4 顆碟做 RAIDZ1 好了，空間比較多。" }),
];
const OPEN = normalizeBranchView({
  lineId: "g-b3",
  parentLineId: "g-root",
  rootLineId: "g-root",
  anchorMessageId: "g-m17",
  purpose: "4TB 與 8TB 硬碟的每 TB 成本與保固",
  kind: "investigate",
  status: "open",
  excerpt: "兩者都容許壞一顆碟",
  draftStatus: "ready",
  unread: 2,
});
const ASIDE = normalizeBranchView({ ...OPEN, lineId: "g-b1a", kind: "aside", status: "discarded", purpose: "scrub 多久跑一次？", closedAt: "2026-10-14T12:00:00Z" });
const MERGED = normalizeBranchView({ ...OPEN, lineId: "g-b1", status: "merged", purpose: "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異", conclusionLine: "兩者都能撐過單碟故障" });
const DISCARDED = normalizeBranchView({ ...OPEN, lineId: "g-b4", status: "discarded", purpose: "二手企業碟可不可靠", conclusionLine: "通電時數普遍超過 4 萬小時，不划算", unread: 0 });
/** The F2 phase 2 structure views over the same tree (outline and map). */
const TREE = [OPEN, MERGED, DISCARDED, normalizeBranchView({ ...ASIDE, parentLineId: "g-b1" })];
const PACK = normalizeBranchPack({ tokenEstimate: 2400, recent: [{ id: "g-m16" }, { id: "g-m17" }], excerpt: "兩者都容許壞一顆碟", rendered: "## Branch background\n\nPurpose of this branch: 4TB 與 8TB…" });
const CARD = normalizeMessage({
  id: "g-c1",
  seq: 24,
  role: "system",
  kind: "branch_card",
  content: "",
  meta: {
    branchLineId: "g-b1",
    card: {
      question: "ZFS mirror 與 Btrfs RAID1 在單碟故障時有什麼差異？",
      conclusion: "兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟。",
      evidence: [{ messageId: "x", note: "ZFS scrub 會用另一顆碟的副本自動修復壞區塊" }],
      impact: "檔案系統改用 ZFS mirror。",
      openItems: ["ECC 記憶體是否必要"],
      needsDecision: [{ branchClaim: "兩顆大碟做 mirror 比較好擴充", mainLineClaim: "預算內買 4 顆碟做 RAIDZ1", mainLineMessageId: "g-m18" }],
      excerpts: [{ messageId: "x", text: "zpool create tank mirror /dev/sda /dev/sdb" }],
    },
  },
});
const NUMBERS = new Map([
  ["g-m17", 17],
  ["g-m18", 18],
]);
const noop = () => undefined;

export function BranchSamples() {
  const [kind, setKind] = useState<"aside" | "investigate" | "alternative">("investigate");
  return (
    <section aria-label="支線元件" className="flex flex-col gap-5 rounded-tg-lg border border-tg-border bg-tg-background p-4">
      <Breadcrumb items={[{ id: "g-root", label: "主線" }, { id: "g-b3", label: OPEN.purpose, kind: "investigate" }]} onSelect={noop} />
      <KindRadio value={kind} onValueChange={setKind} kinds={["aside", "investigate", "alternative"]} />
      <BranchBar branch={OPEN} pack={PACK} parentMessages={PARENT} onBack={noop} onGoToFork={noop} onBringBack={noop} onDiscard={noop} onPromote={noop} />
      <BranchBar branch={ASIDE} parentMessages={PARENT} onBack={noop} onGoToFork={noop} onKeepAsideAsNote={noop} />
      <ForkMarker branches={[OPEN, MERGED, DISCARDED]} onSelect={noop} defaultOpen />
      <BranchCard message={CARD} branch={MERGED} mainNumbers={NUMBERS} defaultExpanded onOpenBranch={noop} onGoToMessage={noop} />
      <BranchCard message={{ ...CARD, id: "g-c2", meta: { ...CARD.meta, delivered: true } }} branch={MERGED} mainNumbers={NUMBERS} onOpenBranch={noop} />
      <BranchResultBar branch={MERGED} onShowCard={noop} />
      <OutlineTree branches={TREE} rootLineId="g-root" currentLineId="g-b3" mainCount={33} onEnter={noop} />
      <div className="flex h-80 flex-col">
        <BranchMap branches={TREE} rootLineId="g-root" currentLineId="g-b3" mainCount={33} onEnter={noop} onToggleFullscreen={noop} />
      </div>
    </section>
  );
}
