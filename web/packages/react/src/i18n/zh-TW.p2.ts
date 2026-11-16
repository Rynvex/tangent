import type { enP2 } from "./en.p2";

/** 一直載入的程式需要的 P2 文字（F5）；其餘跟著懶載入的部分（`p2-messages.ts`）。 */
export const zhTWP2: Record<keyof typeof enP2, string> = {
  "message.pin": "釘選",
  "message.unpin": "取消釘選",
  "message.pinned": "已釘選",
  "message.pinnedSent": "已釘選・一定送出",
  "preview.block.branch_conclusions": "其他支線的結論",
  "message.relate": "關聯…",
  "result.mergedInto": "已合併到「{title}」。",
  "result.mergedIntoLink": "前往「{title}」",
  "branch.mergedInto": "已合併到「{title}」",
  "branch.mergedIntoGone": "已合併到的支線已刪除或移出",
  "pin.failed": "沒有釘選：{reason}",
  "error.goalNotFound": "這個對話沒有目標。",
  "error.relationNotFound": "這條關聯已經不在了。",
  "error.relationExists": "這兩個地方已經有關聯了。",
  "error.relationLimit": "這個對話的關聯已達 {limit} 條。",
  "error.memoLimit": "這段對話的備忘已達 {limit} 則，請先刪掉一些。",
};
