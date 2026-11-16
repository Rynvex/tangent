/**
 * The wording of cross-conversation memory (F6 phase 3, D1): the recall at a
 * new conversation and in the branch form, the notes' footer, the preview's
 * section and the memory suggestions. Imported only by those lazy parts.
 */
import { useBundleT, type MessageBundle } from "./bundle";

const en = {
  "memory.kind.fact": "Fact",
  "memory.kind.decision": "Decision",
  "memory.kind.preference": "Preference",
  "memory.kind.lesson": "Lesson",
  "memory.source": "Source: {label}",
  "memory.importance": "Importance {value}",
  "recall.title": "You concluded before",
  "recall.use": "Bring in these {count}",
  "recall.dismiss": "Dismiss",
  "recall.used": "Brought {count} in at the start of your message; they show in the send preview.",
  "recall.lead": "From earlier conversations:",
  "recall.line": "- [{kind}] {text}",
  "recall.branchTitle": "Bring in what you concluded before",
  "recall.branchItem": "Bring in “{text}”",
  "footer.title": "Cross-conversation memory",
  "footer.notThis": "Not part of this conversation",
  "footer.library": "Memory library",
  "footer.none": "No memory comes in this turn.",
  "footer.note": "The memories a turn brings in are listed only in the send preview; nothing else announces them.",
  "preview.memories": "Memory (across conversations)",
  "preview.memoryScore": "relevance {score}",
  "suggestions.kind.memory": "Memory",
  "suggestions.kind.memory_consolidate": "Consolidate memory",
  "suggestions.memoryAdd": "Remember: {text}",
  "suggestions.memoryUpdate": "Update a memory: {text}",
  "suggestions.memoryNote": "{kind} · importance {importance}",
  "suggestions.consolidateMerge": "Merge into one: {text}",
  "suggestions.consolidateConflict": "They disagree; one memory instead: {text}",
  "suggestions.consolidateFrom": "Was: {texts}",
} as const;

export type MemoryMessageKey = keyof typeof en;

const zhTW: Record<MemoryMessageKey, string> = {
  "memory.kind.fact": "事實",
  "memory.kind.decision": "決定",
  "memory.kind.preference": "偏好",
  "memory.kind.lesson": "教訓",
  "memory.source": "出處：{label}",
  "memory.importance": "重要性 {value}",
  "recall.title": "你之前得出過",
  "recall.use": "帶入這 {count} 條",
  "recall.dismiss": "忽略",
  "recall.used": "已在訊息開頭帶入 {count} 條，會出現在送出前預覽。",
  "recall.lead": "之前得出過：",
  "recall.line": "- [{kind}] {text}",
  "recall.branchTitle": "帶入之前得出過的",
  "recall.branchItem": "帶入「{text}」",
  "footer.title": "跨對話記憶",
  "footer.notThis": "不屬於這段對話",
  "footer.library": "記憶庫",
  "footer.none": "這一輪沒有帶入記憶。",
  "footer.note": "這一輪帶入的記憶，只在送出前預覽裡列出，不另外提示。",
  "preview.memories": "記憶（跨對話）",
  "preview.memoryScore": "相關度 {score}",
  "suggestions.kind.memory": "記憶",
  "suggestions.kind.memory_consolidate": "整併記憶",
  "suggestions.memoryAdd": "記住：{text}",
  "suggestions.memoryUpdate": "更新記憶：{text}",
  "suggestions.memoryNote": "{kind}・重要性 {importance}",
  "suggestions.consolidateMerge": "合併成一條：{text}",
  "suggestions.consolidateConflict": "兩條互相矛盾，改成一條：{text}",
  "suggestions.consolidateFrom": "原本：{texts}",
};

const ja: Record<MemoryMessageKey, string> = {
  "memory.kind.fact": "事実",
  "memory.kind.decision": "決定",
  "memory.kind.preference": "好み・方針",
  "memory.kind.lesson": "教訓",
  "memory.source": "出典：{label}",
  "memory.importance": "重要度 {value}",
  "recall.title": "過去の会話での結論",
  "recall.use": "これら {count} 件を取り込む",
  "recall.dismiss": "閉じる",
  "recall.used": "メッセージ冒頭に {count} 件を取り込みました（送信前プレビューで確認できます）。",
  "recall.lead": "以前の会話から：",
  "recall.line": "- [{kind}] {text}",
  "recall.branchTitle": "過去の結論を取り込む",
  "recall.branchItem": "「{text}」を取り込む",
  "footer.title": "長期メモリ（会話横断）",
  "footer.notThis": "この会話の履歴には属しません",
  "footer.library": "メモリライブラリ",
  "footer.none": "このターンではメモリは読み込まれません。",
  "footer.note": "このターンで参照されるメモリは「送信前プレビュー」にのみ一覧表示され、別途通知は出ません。",
  "preview.memories": "長期メモリ（会話横断）",
  "preview.memoryScore": "関連度 {score}",
  "suggestions.kind.memory": "メモリ",
  "suggestions.kind.memory_consolidate": "メモリ統合",
  "suggestions.memoryAdd": "記憶する：{text}",
  "suggestions.memoryUpdate": "メモリを更新：{text}",
  "suggestions.memoryNote": "{kind}・重要度 {importance}",
  "suggestions.consolidateMerge": "1つに統合：{text}",
  "suggestions.consolidateConflict": "矛盾を解消して1つに：{text}",
  "suggestions.consolidateFrom": "統合前：{texts}",
};

export const MEMORY_MESSAGES: MessageBundle<MemoryMessageKey> = { en, "zh-TW": zhTW, ja };

/** The translator of the memory parts: their own strings, then the bundled dictionary (host overrides first). */
export const useMemoryT = () => useBundleT(MEMORY_MESSAGES);

/** Each memory kind's name. */
export const MEMORY_KIND_KEYS = {
  fact: "memory.kind.fact",
  decision: "memory.kind.decision",
  preference: "memory.kind.preference",
  lesson: "memory.kind.lesson",
} as const;
