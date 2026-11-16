import type { enP3 } from "./en.p3";

/** zh-TW of `en.p3.ts`. */
export const zhTWP3: Record<keyof typeof enP3, string> = {
  "message.foldFrom": "從這則起折疊…",
  "tag.kind.question": "問題",
  "tag.kind.idea": "想法",
  "tag.kind.pro": "贊成",
  "tag.kind.con": "反對",
  "tag.kind.decision": "決定",
  "tag.anchor": "分岔處是「{kind}」",
  "map.nodeTag": "{name}，{tag}",
  "error.foldNotFound": "這個折疊已經不在了。",
  "error.foldOverlap": "這段和另一個折疊重疊了。",
  "error.foldLimit": "這條線的折疊已經到上限（{limit} 個）。",
  "error.invalidFold": "折疊要包含 2 到 200 則已完成的訊息。",
  "message.diverge": "給我幾個方向…",
  "error.comparisonNotFound": "這個比較已經不在了。",
  "error.comparisonNotReady": "比較表還沒寫好。",
  "error.comparisonDecided": "這個比較已經決定過了。",
  "error.invalidComparison": "比較要選同一條線底下 2 到 5 條進行中的支線。",
  "preview.block.memory": "記憶（跨對話）",
  "error.memoryNotFound": "這條記憶已經不在了。",
  "error.memorySuperseded": "這條記憶已被取代；請改現在的那一條。",
  "error.embedderUnavailable": "記憶服務暫時不能用，請稍後再試。",
  "error.invalidMemory": "記憶要有種類、內容，重要性在 1 到 10 之間。",
};
