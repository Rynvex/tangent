/**
 * Scenario 1 of the design brief, "家用 NAS 與備份策略", with the prototype's
 * text (docs/design/prototype-v2). Only the messages the prototype shows are
 * included; `seq` keeps the gaps of the elided ones.
 */
import { FEATURE_NAMES, AI_FEATURES, type CapabilityFeature } from "../capabilities";
import type { Leaf, LeafKind, LineView, Message, Seed, Suggestion } from "../types";
import { MOCK_CHAPTER_LIMITS, MOCK_NOTE_LIMITS, fixture, type MockScenario } from "./scenario";

export const NAS_ROOT_ID = "nas";
const NAS = NAS_ROOT_ID;

/** Taipei evening times of the prototype, as UTC. */
const at = (day: number, hour: number, minute: number) => new Date(Date.UTC(2026, 9, day, hour - 8, minute)).toISOString();

const USAGE = { provider: "anthropic", model: "claude-sonnet-4-5" };

function user(id: string, lineId: string, seq: number, content: string, createdAt: string): Message {
  return fixture.message({ id, lineId, seq, role: "user", content, createdAt });
}

function ai(id: string, lineId: string, seq: number, content: string, createdAt: string, extra: Record<string, unknown> = {}): Message {
  return fixture.message({ id, lineId, seq, role: "assistant", content, createdAt, meta: { ...USAGE, usage: { inputTokens: 900, outputTokens: 220, costUsd: 0.006 } }, ...extra });
}

const ZFS_CARD = fixture.card({
  question: "ZFS mirror 與 Btrfs RAID1 在單碟故障時有什麼差異？",
  conclusion: "兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟。",
  evidence: [
    { messageId: "nas-b1-2", note: "Btrfs RAID1 降級時需要手動 mount -o degraded" },
    { messageId: "nas-b1-3", note: "ZFS scrub 會用另一顆碟的副本自動修復壞區塊" },
    { messageId: "nas-b1-2", note: "ZFS 換碟後 zpool replace 自動重建" },
  ],
  impact: "檔案系統改用 ZFS mirror。",
  openItems: ["ECC 記憶體是否必要"],
  needsDecision: [{ branchClaim: "兩顆大碟做 mirror 比較好擴充", mainLineClaim: "預算內買 4 顆碟做 RAIDZ1", mainLineMessageId: "nas-m18" }],
  excerpts: [{ messageId: "nas-b1-2", text: "zpool create tank mirror /dev/sda /dev/sdb" }],
});

const MAIN_MESSAGES: Message[] = [
  user("nas-m16", NAS, 16, "需求大概清楚了：現有 2.1TB，每年長 400GB，預算 3 萬。硬碟要怎麼配？", at(12, 21, 4)),
  ai(
    "nas-m17",
    NAS,
    17,
    [
      "以 5 年估算，總量約 4.1TB；留一倍餘裕，需要約 8TB 可用空間。常見的兩種配法：",
      "",
      "| 配法 | 可用空間 | 約略價格 | 擴充 |",
      "|---|---|---|---|",
      "| 4 × 4TB RAIDZ1 | 約 12TB | NT$ 14,000 | 要一次換 4 顆 |",
      "| 2 × 8TB mirror | 約 8TB | NT$ 13,600 | 再加 2 顆就能擴 |",
      "",
      "兩者都容許壞一顆碟。差別在擴充方式與重建風險：RAIDZ1 重建時其餘 3 顆都要全速讀取。",
    ].join("\n"),
    at(12, 21, 6),
  ),
  user("nas-m18", NAS, 18, "預算內買 4 顆碟做 RAIDZ1 好了，空間比較多。", at(12, 21, 40)),
  ai(
    "nas-m19",
    NAS,
    19,
    [
      "## 檔案系統：ZFS 或 Btrfs",
      "",
      "ZFS 與 Btrfs 都提供資料校驗與快照，對家用 NAS 都夠用。主要差別：",
      "",
      "- ZFS：成熟、文件多；vdev 擴充較不彈性",
      "- Btrfs：可以混用不同容量的碟；RAID5/6 仍不建議使用",
      "- 兩者都要定期 scrub 才能發現靜默損壞",
      "",
      "$$可用空間 \\approx 單碟容量 \\times N \\div 2$$",
      "",
      "如果維持 4 顆碟 RAIDZ1，就只能選 ZFS。",
    ].join("\n"),
    at(12, 21, 42),
  ),
  fixture.message({
    id: "nas-c1",
    lineId: NAS,
    seq: 24,
    role: "system",
    kind: "branch_card",
    content: ZFS_CARD.conclusion,
    createdAt: at(12, 22, 0),
    meta: { card: ZFS_CARD, branchLineId: "nas-b1", delivered: true },
  }),
  user("nas-m25", NAS, 25, "好，那就 ZFS mirror。ECC 的事等等再說。", at(12, 22, 2)),
  ai("nas-m26", NAS, 26, "好。紀要已記下「檔案系統用 ZFS mirror」，ECC 放進待確認。需要的話，我可以列出支援 ECC 的主機板。", at(12, 22, 3)),
  user("nas-m39", NAS, 39, "那備份呢？本地快照之外，異地要放哪？", at(14, 20, 10)),
  ai(
    "nas-m40",
    NAS,
    40,
    [
      "照 3-2-1 原則：3 份資料、2 種媒介、1 份在異地。以 2.1TB 計，Backblaze B2 每月約 US$ 13。",
      "",
      "```sh",
      "rclone sync /tank/photos b2:home-nas/photos \\",
      "  --fast-list --transfers 8",
      "```",
      "",
      "本地 ZFS 快照處理誤刪；雲端那份處理火災、竊盜這類整台遺失的情況。",
    ].join("\n"),
    at(14, 20, 12),
    {
      meta: {
        ...USAGE,
        suggestions: [
          { purpose: "B2 與 Wasabi 的取回費用差異", kind: "investigate" },
          { purpose: "rclone 的 --fast-list 是做什麼的？", kind: "aside" },
        ],
      },
    },
  ),
];

const BRANCH_MESSAGES: Message[] = [
  user("nas-b1-1", "nas-b1", 101, "單碟故障時，ZFS mirror 和 Btrfs RAID1 各會怎樣？", at(12, 21, 45)),
  ai("nas-b1-2", "nas-b1", 102, "兩者都能繼續讀寫。ZFS pool 會進入 DEGRADED，換碟後執行 zpool replace 自動重建。\n\nBtrfs RAID1 少一顆碟時，重新開機需要手動 mount -o degraded，否則會掛載失敗。", at(12, 21, 46)),
  ai("nas-b1-3", "nas-b1", 103, "ZFS 的 scrub 會比對兩顆碟的校驗值，發現壞區塊時用另一份副本自動修復；Btrfs 也有 scrub，但家用場景的修復紀錄較少。", at(12, 21, 48)),
  user("nas-b1-4", "nas-b1", 104, "了解，結論帶回主線吧。", at(12, 21, 58)),
  user("nas-b1a-1", "nas-b1a", 105, "scrub 多久跑一次？", at(12, 21, 50)),
  ai("nas-b1a-2", "nas-b1a", 106, "一般建議每月一次。2TB 的資料約跑 3 小時，可以排在半夜。", at(12, 21, 51)),
  user("nas-b3-1", "nas-b3", 107, "幫我比較 4TB 和 8TB 的每 TB 成本，順便看保固。", at(12, 21, 10)),
  ai(
    "nas-b3-2",
    "nas-b3",
    108,
    "| 型號 | 容量 | 價格 | 每 TB | 保固 |\n|---|---|---|---|---|\n| WD Red Plus | 4TB | NT$ 3,500 | NT$ 875 | 3 年 |\n| WD Red Plus | 8TB | NT$ 6,800 | NT$ 850 | 3 年 |\n| IronWolf | 8TB | NT$ 6,600 | NT$ 825 | 3 年 |",
    at(12, 21, 12),
  ),
  user("nas-b3-3", "nas-b3", 109, "8TB 有沒有 SMR 的地雷？", at(12, 21, 20)),
  ai("nas-b3-4", "nas-b3", 110, "WD Red Plus 與 IronWolf 的 8TB 都是 CMR，沒有 SMR 的問題。要避開的是不帶 Plus 的 WD Red（2–6TB 有 SMR 型號）。", at(12, 21, 21)),
  ai("nas-b3-5", "nas-b3", 111, "整理一下：兩顆 8TB 比四顆 4TB 便宜約 NT$ 400，每 TB 成本也較低，保固相同。", at(12, 21, 22)),
  user("nas-b2-13", "nas-b2", 125, "如果 NAS 只做快取，硬碟是不是一顆就夠？", at(14, 21, 30)),
  ai("nas-b2-14", "nas-b2", 126, "", at(14, 21, 31), { status: "error", meta: { ...USAGE, error: "AI 服務沒有回應（逾時 60 秒）。這則沒有計費。" } }),
];

interface BranchSeed {
  id: string;
  parent: string;
  anchor: string;
  kind: string;
  status: string;
  purpose: string;
  messageCount: number;
  unread?: number;
  conclusionLine?: string;
  excerpt?: string;
  createdAt: string;
  /** Its last turn, when after `createdAt`. */
  lastActivityAt?: string;
}

const BRANCH_SEEDS: BranchSeed[] = [
  { id: "nas-b5", parent: NAS, anchor: "nas-m5", kind: "alternative", status: "discarded", purpose: "用舊筆電當 NAS", messageCount: 4, conclusionLine: "只能接一顆碟、沒有 ECC", createdAt: at(12, 20, 40) },
  { id: "nas-b3", parent: NAS, anchor: "nas-m17", kind: "investigate", status: "open", purpose: "4TB 與 8TB 硬碟的每 TB 成本與保固", messageCount: 5, unread: 2, excerpt: "兩者都容許壞一顆碟", createdAt: at(12, 21, 9), lastActivityAt: at(15, 20, 30) },
  { id: "nas-b4", parent: NAS, anchor: "nas-m17", kind: "investigate", status: "discarded", purpose: "二手企業碟可不可靠", messageCount: 5, conclusionLine: "通電時數普遍超過 4 萬小時、賣家保固只有 7 天，不划算", createdAt: at(12, 21, 15) },
  { id: "nas-b1", parent: NAS, anchor: "nas-m19", kind: "investigate", status: "merged", purpose: "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異", messageCount: 4, conclusionLine: "兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟", excerpt: "ZFS 與 Btrfs 都提供資料校驗與快照", createdAt: at(12, 21, 44) },
  { id: "nas-b1a", parent: "nas-b1", anchor: "nas-b1-3", kind: "aside", status: "merged", purpose: "scrub 多久跑一次？", messageCount: 2, conclusionLine: "每月一次；2TB 約跑 3 小時", createdAt: at(12, 21, 49) },
  { id: "nas-b2", parent: NAS, anchor: "nas-m40", kind: "alternative", status: "open", purpose: "改用雲端備份（Backblaze B2），NAS 只做本地快取", messageCount: 14, createdAt: at(14, 20, 20) },
];

function depthOf(seed: BranchSeed): number {
  return seed.parent === NAS ? 1 : 2;
}

/** The prototype's leaves (B1): the ended branches' dead ends, the merged card's conclusion and the aside's answer. */
const LEAF_OF: Readonly<Record<string, { kind: LeafKind; line: string; body?: string }>> = {
  "nas-b5": { kind: "dead_end", line: "只能接一顆碟、沒有 ECC" },
  "nas-b4": { kind: "dead_end", line: "通電時數普遍超過 4 萬小時、賣家保固只有 7 天，不划算" },
  "nas-b1": { kind: "conclusion", line: "兩者都能撐過單碟故障；ZFS 的 scrub 與自我修復較成熟", body: "ZFS mirror 與 Btrfs RAID1 在單碟故障時有什麼差異？\n- Btrfs RAID1 降級時需要手動 mount -o degraded\n- ECC 記憶體是否必要" },
  "nas-b1a": { kind: "answer", line: "每月一次；2TB 約跑 3 小時" },
};

const LEAVES: Record<string, Leaf> = Object.fromEntries(
  Object.entries(LEAF_OF).map(([lineId, leaf]) => {
    const createdAt = BRANCH_SEEDS.find((seed) => seed.id === lineId)?.createdAt ?? at(12, 22, 0);
    return [lineId, { lineId, rootLineId: NAS, body: "", ...leaf, status: "confirmed", aiDrafted: false, createdBy: "demo", createdAt, updatedAt: createdAt }];
  }),
);

const BRANCHES = BRANCH_SEEDS.map((seed) =>
  fixture.branch({
    lineId: seed.id,
    parentLineId: seed.parent,
    rootLineId: NAS,
    anchorMessageId: seed.anchor,
    depth: depthOf(seed),
    purpose: seed.purpose,
    kind: seed.kind,
    status: seed.status,
    origin: seed.excerpt ? "selection" : "button",
    excerpt: seed.excerpt ?? "",
    conclusionLine: seed.conclusionLine ?? "",
    cardMessageId: seed.id === "nas-b1" ? "nas-c1" : "",
    unread: seed.unread ?? 0,
    messageCount: seed.messageCount,
    draftStatus: "none",
    createdAt: seed.createdAt,
    closedAt: seed.status === "open" ? null : seed.createdAt,
    lastActivityAt: seed.lastActivityAt ?? seed.createdAt,
    leaf: LEAF_OF[seed.id] ? { kind: LEAF_OF[seed.id]!.kind, line: LEAF_OF[seed.id]!.line, status: "confirmed" } : null,
    ...USAGE,
  }),
);

/** The prototype's parking lot (B3): three thoughts from the main line. */
const SEEDS: Seed[] = [
  ["nas-s1", "UPS 要不要買？", "nas-m18", "主線 #3", at(12, 21, 41)],
  ["nas-s2", "NAS 要不要開外網存取？", "nas-m26", "主線 #6", at(12, 22, 4)],
  ["nas-s3", "異地備份多久同步一次？", "nas-m40", "主線 #8", at(14, 20, 13)],
].map(([id, text, anchorMessageId, sourceLabel, createdAt]) => ({
  id: id!,
  rootLineId: NAS,
  anchorMessageId: anchorMessageId!,
  anchorLineId: NAS,
  sourceLabel: sourceLabel!,
  text: text!,
  status: "open",
  expandedLineId: "",
  noteId: "",
  createdBy: "demo",
  createdAt: createdAt!,
  updatedAt: createdAt!,
}));

/** Phase A has no feature that proposes real suggestions; the test probe's one shows the inbox (B5). */
const SUGGESTIONS: Suggestion[] = [
  {
    id: "nas-g1",
    rootLineId: NAS,
    lineId: "nas-b2",
    feature: "suggestion_probe",
    kind: "probe",
    targetKey: "line:nas-b2",
    payload: { reason: "回覆要求了一則測試用的建議。" },
    status: "open",
    createdAt: at(14, 21, 32),
    decidedAt: null,
  },
];

function lineFromSeed(seed: BranchSeed): LineView {
  return fixture.line({
    id: seed.id,
    title: seed.purpose,
    unread: seed.unread ?? 0,
    lastActivityAt: seed.lastActivityAt ?? seed.createdAt,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
    conversationBranch: { parentLineId: seed.parent, rootLineId: NAS, anchorMessageId: seed.anchor, depth: depthOf(seed), purpose: seed.purpose, kind: seed.kind, status: seed.status, origin: "button" },
    ...USAGE,
  });
}

function mainLine(id: string, title: string, lastActivityAt: string, extra: Record<string, unknown> = {}): LineView {
  return fixture.line({ id, title, lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt, ...USAGE, ...extra });
}

const LINES: LineView[] = [
  // 累計：主線約 38k token、US$0.21 (design brief, scenario 1).
  mainLine(NAS, "家用 NAS 與備份策略", at(15, 20, 42), {
    branchCounts: { open: 2, merged: 1, discarded: 2, promoted: 0 },
    branchUnread: 2,
    openSeeds: SEEDS.length,
    openSuggestions: SUGGESTIONS.length,
    staleBranches: 1,
    notesRevision: 7,
    usage: { inputTokens: 33_100, outputTokens: 5_200, costUsd: 0.21 },
    // B18: a folder and tags (the list's folders and #tag filter).
    folder: "家用設備",
    tags: ["nas", "zfs", "備份"],
  }),
  mainLine("osaka", "日本行程：大阪 4 天", at(15, 9, 15), { branchCounts: { open: 1, merged: 0, discarded: 0, promoted: 0 }, branchUnread: 1, usage: { inputTokens: 8_400, outputTokens: 1_900, costUsd: 0.05 }, folder: "旅行", tags: ["日本"] }),
  mainLine("rust", "學習 Rust 的所有權與借用", at(13, 19, 0), { branchCounts: { open: 1, merged: 1, discarded: 0, promoted: 0 }, usage: { inputTokens: 12_000, outputTokens: 3_000, costUsd: 0.08 }, tags: ["rust"] }),
  mainLine("okr", "週報的 OKR 用語", at(12, 10, 0), { usage: { inputTokens: 900, outputTokens: 300, costUsd: 0.004 } }),
  mainLine("arch-1", "Proxmox 叢集規劃", at(2, 21, 0), { archivedAt: at(5, 9, 0), folder: "家用設備", tags: ["proxmox", "nas"] }),
  mainLine("arch-2", "咖啡豆的保存方式", at(1, 8, 0), { archivedAt: at(4, 9, 0) }),
  ...BRANCH_SEEDS.map(lineFromSeed),
];

const B3_DRAFT = fixture.card({
  question: "4TB 與 8TB 硬碟的每 TB 成本與保固差多少？",
  conclusion: "8TB 每 TB 成本最低（約 NT$ 825–850），保固與 4TB 同為 3 年；兩顆 8TB 比四顆 4TB 便宜約 NT$ 400。",
  evidence: [
    { messageId: "nas-b3-2", note: "三款碟的價格與每 TB 成本比較表" },
    { messageId: "nas-b3-4", note: "WD Red Plus 與 IronWolf 8TB 都是 CMR" },
    { messageId: "nas-b3-5", note: "兩顆 8TB 比四顆 4TB 便宜約 NT$ 400" },
  ],
  impact: "硬碟配置傾向 2 × 8TB mirror，與主線「4 顆 RAIDZ1」的說法不同。",
  openItems: ["8TB 重建約需 14 小時，是否可以接受"],
  needsDecision: [{ branchClaim: "2 × 8TB mirror 總價較低、擴充只要再加 2 顆", mainLineClaim: "預算內買 4 顆碟做 RAIDZ1", mainLineMessageId: "nas-m18" }],
  excerpts: [{ messageId: "nas-b3-2", text: "WD Red Plus 8TB　NT$ 6,800　3 年保固" }],
});

/** A message source always names its line too (the server fills it in); scenario messages are on the main line. */
const NOTE = (id: string, section: string, text: string, extra: Record<string, unknown> = {}) =>
  fixture.note({ id, section, text, status: "active", createdAt: at(12, 22, 3), updatedAt: at(12, 22, 3), ...(extra.sourceMessageId ? { sourceLineId: NAS } : {}), ...extra });

const NOTES = [
  NOTE("n0", "decided", "檔案系統用 Btrfs", { status: "superseded", supersededBy: "n1", sourceMessageId: "nas-m20" }),
  NOTE("n1", "decided", "檔案系統用 ZFS mirror", { sourceLineId: "nas-b1", sourceCardMessageId: "nas-c1" }),
  NOTE("n2", "decided", "預算上限 3 萬", { sourceMessageId: "nas-m3" }),
  NOTE("n3", "decided", "硬碟：4 × 4TB RAIDZ1", { sourceMessageId: "nas-m18" }),
  NOTE("n4", "fact", "現有資料 2.1TB、每年成長約 400GB", { sourceMessageId: "nas-m9" }),
  NOTE("n5", "to_confirm", "ECC 記憶體是否必要", { sourceLineId: "nas-b1", sourceCardMessageId: "nas-c1" }),
  NOTE("n6", "todo", "列出 3 款支援 ECC 的主機板", { sourceMessageId: "nas-m26" }),
];

/** B13: one memo on the ZFS branch, the kind of thought that should not go to the AI. */
const MEMOS = [
  { id: "memo-1", rootLineId: NAS, lineId: "nas-b1", sourceLabel: "查證・ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異", text: "問一下小陳他家的 ZFS 跑了幾年、有沒有遇過 scrub 修不回來的情況。", createdBy: "demo", createdAt: at(12, 22, 10), updatedAt: at(12, 22, 10) },
];

const CHAPTERS = fixture.chapters(NAS, {
  chapters: [
    { index: 0, title: "需求盤點", titleSource: "topic", kind: "start", startMessageId: "nas-m1", endMessageId: "nas-m15", startAt: at(12, 20, 30), endAt: at(12, 21, 0), messageCount: 15, branchIds: ["nas-b5"] },
    { index: 1, title: "硬體選擇", titleSource: "topic", kind: "topic", startMessageId: "nas-m16", endMessageId: "nas-m18", startAt: at(12, 21, 4), endAt: at(12, 21, 40), messageCount: 3, branchIds: ["nas-b3", "nas-b4"] },
    { index: 2, title: "檔案系統", titleSource: "topic", kind: "topic", startMessageId: "nas-m19", endMessageId: "nas-m38", startAt: at(12, 21, 40), endAt: at(12, 22, 15), messageCount: 20, branchIds: ["nas-b1"], cardMessageIds: ["nas-c1"] },
    { index: 3, title: "備份策略", titleSource: "topic", kind: "idle", startMessageId: "nas-m39", endMessageId: "nas-m40", startAt: at(14, 20, 10), endAt: at(14, 20, 12), messageCount: 2, branchIds: ["nas-b2"] },
  ],
});

/**
 * The scenario's present (B9 open loops): two days after the last turn, so
 * 「改用雲端備份」(idle since the 14th) is stale and the disk-price branch is not.
 */
const SCENARIO_NOW = at(17, 21, 0);

/** The prototype's goal (C4) and what an AI proposal says (the fake runner's text elsewhere). */
const GOALS = {
  [NAS]: { rootLineId: NAS, text: "在 3 萬元內做出可以撐 5 年、不會因為單一故障而遺失資料的家用儲存與備份", source: "manual", updatedBy: "demo", createdAt: at(12, 20, 35), updatedAt: at(12, 20, 35) },
  // The e2e "fresh conversation" (okr) has one, so its turns never draw a goal proposal; rust and osaka have none.
  okr: { rootLineId: "okr", text: "把週報裡的 OKR 用語統一", source: "manual", updatedBy: "demo", createdAt: at(12, 10, 0), updatedAt: at(12, 10, 0) },
} as const;
const GOAL_PROPOSALS = {
  [NAS]: "在 3 萬元內完成可撐 5 年的家用儲存，任一硬碟或整台設備故障都不遺失資料",
  "*": "釐清這段對話要決定的事，並得出一個結論",
};

/** The models the mock "server" allows (B5 `/capabilities.models`): the scenario's model and a cheaper one. */
const MOCK_MODELS = [{ provider: "anthropic", models: ["claude-haiku-4-5", "claude-sonnet-4-5"] }];

/** AI features in the prototype's modes (設定頁). */
const MODES: Record<string, "manual" | "suggest" | "auto"> = { summary: "auto", card_draft: "manual", branch_suggest: "suggest", leaf: "suggest", rebalance: "suggest", group: "suggest", relations: "suggest", goal: "suggest", memory: "suggest", ibis: "suggest", diverge: "manual", fold: "suggest" };

/** The features the C1 milestone ships: no P1 feature, so 待處理 stays hidden (DESIGN §12, F0). */
const C1_FEATURES: ReadonlySet<string> = new Set(["notes", "chapters", "aside", "summary", "card_draft"]);

/**
 * The settings' three presets (F9 B.4), as `TANGENT_FEATURES` would say them:
 * 標準推薦 (the everyday set), 深度研究與決策 (the reference server's
 * default: argument types, diverging, relations, groups, goal), 輕量學習筆記
 * (notes, summaries and memos, without the discussion tools). Each keeps the
 * library's requirements (rebalance, group, diverge and fisheye need leaf;
 * memory and parking need notes).
 */
export const MOCK_FEATURE_PRESETS = {
  standard: ["notes", "chapters", "aside", "summary:suggest", "card_draft", "branch_suggest:suggest", "search", "leaf:suggest", "parking", "spinoff", "open_loops", "memo", "glossary", "fold:suggest"],
  research: [
    "notes",
    "chapters",
    "aside",
    "summary:suggest",
    "card_draft",
    "branch_suggest:suggest",
    "search",
    "leaf:suggest",
    "parking",
    "spinoff",
    "rebalance:suggest",
    "goal:suggest",
    "relations:suggest",
    "open_loops",
    "group:suggest",
    "ibis:suggest",
    "fold:suggest",
    "diverge:manual",
    "memo",
    "glossary",
  ],
  learning: ["notes", "chapters", "aside", "summary:auto", "card_draft", "search", "leaf:suggest", "memo", "glossary", "fold:suggest"],
} as const satisfies Record<string, readonly string[]>;
export type MockFeaturePreset = keyof typeof MOCK_FEATURE_PRESETS;

/** The features whose suggestions fill the inbox: `suggestions` is on with any of them (the server's inboxOn). */
const SUGGESTION_PRODUCERS: ReadonlySet<string> = new Set(["rebalance", "group", "fold", "goal", "relations", "memory"]);

/**
 * Which features the mock reports: `all` (the prototype), `c1` (what exists
 * before C2: notes, chapters, summary, drafts; no inbox), `core` (none), or
 * one of the settings' presets.
 */
export type MockFeatureSet = "all" | "c1" | "core" | MockFeaturePreset;

function presetCapabilities(preset: MockFeaturePreset): CapabilityFeature[] {
  const modes = new Map<string, string | undefined>(MOCK_FEATURE_PRESETS[preset].map((entry) => entry.split(":") as [string, string | undefined]));
  const inbox = [...modes.keys()].some((name) => SUGGESTION_PRODUCERS.has(name));
  return FEATURE_NAMES.map((name) => {
    const enabled = name === "suggestions" ? inbox : modes.has(name);
    if (!AI_FEATURES.has(name) || !enabled) return { name, enabled };
    return { name, enabled, mode: (modes.get(name) ?? MODES[name] ?? "manual") as "manual" | "suggest" | "auto" };
  });
}

export function mockCapabilities(set: MockFeatureSet): CapabilityFeature[] {
  if (set in MOCK_FEATURE_PRESETS) return presetCapabilities(set as MockFeaturePreset);
  return FEATURE_NAMES.map((name) => {
    const enabled = set === "all" || (set === "c1" && C1_FEATURES.has(name));
    return AI_FEATURES.has(name) && enabled ? { name, enabled, mode: MODES[name] ?? "manual" } : { name, enabled };
  });
}

export interface NasScenarioOptions {
  features?: MockFeatureSet;
}

/** A fresh copy of scenario 1; each mock client gets its own. */
export function nasScenario(options: NasScenarioOptions = {}): MockScenario {
  return {
    lines: LINES,
    messages: [...MAIN_MESSAGES, ...BRANCH_MESSAGES],
    branches: BRANCHES,
    draftCards: { "nas-b3": B3_DRAFT, "nas-b2": fixture.card({ question: "雲端備份能不能取代 NAS？", conclusion: "", evidence: [] }) },
    notesByRoot: { [NAS]: NOTES },
    chaptersByLine: { [NAS]: CHAPTERS },
    leaves: LEAVES,
    seeds: SEEDS,
    memos: MEMOS,
    suggestions: SUGGESTIONS,
    goals: { ...GOALS },
    goalProposals: GOAL_PROPOSALS,
    now: SCENARIO_NOW,
    capabilities: { features: mockCapabilities(options.features ?? "all"), permissions: { canWrite: true }, models: MOCK_MODELS },
    noteLimits: MOCK_NOTE_LIMITS,
    chapterLimits: MOCK_CHAPTER_LIMITS,
    replies: {
      [NAS]: "UPS 建議買一台 600VA 以上、支援 USB 通知的機種：斷電時讓 NAS 自動關機，避免 ZFS 在寫入途中斷電。價格約 NT$ 2,500，仍在預算內。",
      "*": "B2 儲存每 TB 每月 US$ 6，下載量在儲存量 3 倍內免費。2.1TB 初次上傳以 100Mbps 估算約需 2 天，之後每天只同步差異。",
    },
  };
}
