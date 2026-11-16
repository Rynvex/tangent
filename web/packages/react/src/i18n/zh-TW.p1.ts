import type { enP1 } from "./en.p1";

/** P1 用語中一直載入的部分（收尾類型、停車提示、B8 錯誤、功能名稱）；其他的跟著用到它們的懶載入部分載入（`p1-messages.ts`）。 */
export const zhTWP1: Record<keyof typeof enP1, string> = {
  "leaf.kind.conclusion": "結論",
  "leaf.kind.decision": "決定",
  "leaf.kind.answer": "答案",
  "leaf.kind.dead_end": "死路",
  "leaf.kind.to_continue": "待續",
  "leaf.kindPrefix": "{kind}：",
  "parking.parked": "已停車・不花 token",
  "parking.emptyComposer": "先在輸入框寫下念頭，再按停車。",
  "parking.tooLong": "種子最多 {limit} 字，先縮短再停車。",
  "parking.failed": "沒有停車：{reason}",
  "feature.suggestions": "建議匣",
  "error.seedNotOpen": "這顆種子已經展開、記進紀要或丟掉了。",
  "error.seedNotFound": "這顆種子已經不在了。",
  "error.seedLimit": "停車場滿了（{limit} 顆）。展開、記進紀要或丟掉幾顆，才有位子停新的。",
  "error.suggestionNotOpen": "這則建議已經處理過或已過期。",
  "error.suggestionNotFound": "這則建議已經不在了。",
  "error.leafNotFound": "這條支線沒有收尾。",
  "error.invalidLeaf": "收尾不合格，請檢查類型與字數。",
  // 獨立成新對話的連結（B2），跟著訊息清單與對話一直載入
  "message.spunOff": "已獨立成新對話",
  "marker.spunOffLink": "已獨立 →「{title}」",
  "spinoff.from": "來自：{title}",
  "message.spinoff": "從這裡開新對話",
  "spinoff.fromGone": "來自：{title}（對話已刪除）",
  "marker.spunOffGone": "已獨立 →「{title}」（對話已刪除）",
};
