/**
 * The F12 wording the demo frame owns: the side panel's resizer (S3), the
 * background-reply toast (S4) and the card edit's confirmation (S6). Small,
 * and used by always-loaded frame parts.
 */
import { useBundleT, type MessageBundle } from "@tangent/react";

const en = {
  "side.resize": "Resize side panel",
  "side.resizeHint": "Drag to resize · double-click to reset to {w}",
  "side.maxWidth": "At {vw} wide, the panel can be at most {max} px so the conversation keeps 480 px.",
  "side.minWidth": "The panel is at its narrowest ({min} px).",
  "side.width": "{w} px",
  "list.resize": "Resize conversation list",
  "list.resizeHint": "Drag to resize · double-click to reset to {w}",
  "list.maxWidth": "At {vw} wide, the list can be at most {max} px so the conversation keeps 480 px.",
  "list.minWidth": "The list is at its narrowest ({min} px).",
  "toast.replyDone": "“{title}” has an answer",
  "toast.replyDoneN": "“{title}” and {more} more have answers",
  "toast.replyFailed": "“{title}” didn’t finish",
  "toast.goView": "View",
  "toast.close": "Close notification",
  "card.edited": "Conclusion saved; the main line’s next turn includes it.",
};

export type F12ShellMessageKey = keyof typeof en;

const zhTW: Record<F12ShellMessageKey, string> = {
  "side.resize": "調整側欄寬度",
  "side.resizeHint": "拖拉調整寬度・雙擊重設為 {w}",
  "side.maxWidth": "視窗 {vw} 寬時，側欄最多 {max} px，讓對話維持至少 480 px。",
  "side.minWidth": "側欄已是最窄（{min} px）。",
  "side.width": "{w} px",
  "list.resize": "調整對話清單寬度",
  "list.resizeHint": "拖拉調整寬度・雙擊重設為 {w}",
  "list.maxWidth": "視窗 {vw} 寬時，對話清單最多 {max} px，讓對話維持至少 480 px。",
  "list.minWidth": "對話清單已是最窄（{min} px）。",
  "toast.replyDone": "「{title}」已回答完畢",
  "toast.replyDoneN": "「{title}」等 {n} 條已回答完畢",
  "toast.replyFailed": "「{title}」沒有回答完",
  "toast.goView": "前往查看",
  "toast.close": "關閉通知",
  "card.edited": "結論已儲存，主線下一輪會帶入。",
};

const ja: Record<F12ShellMessageKey, string> = {
  "side.resize": "サイドパネルの幅を調整",
  "side.resizeHint": "ドラッグでサイズ変更・ダブルクリックで {w} にリセット",
  "side.maxWidth": "画面幅 {vw} の場合、会話領域に 480 px を確保するためサイドパネルは最大 {max} px までです。",
  "side.minWidth": "サイドパネルは最小幅（{min} px）です。",
  "side.width": "{w} px",
  "list.resize": "会話一覧の幅を調整",
  "list.resizeHint": "ドラッグでサイズ変更・ダブルクリックで {w} にリセット",
  "list.maxWidth": "画面幅 {vw} の場合、会話領域に 480 px を確保するため一覧は最大 {max} px までです。",
  "list.minWidth": "会話一覧は最小幅（{min} px）です。",
  "toast.replyDone": "「{title}」の回答が完了しました",
  "toast.replyDoneN": "「{title}」ほか {more} 件の回答が完了しました",
  "toast.replyFailed": "「{title}」の応答を完了できませんでした",
  "toast.goView": "表示",
  "toast.close": "通知を閉じる",
  "card.edited": "結論を保存しました。メインラインの次のターンに反映されます。",
};

export const F12_SHELL_MESSAGES: MessageBundle<F12ShellMessageKey> = { en, "zh-TW": zhTW, ja };

/** The translator of the F12 frame parts. */
export const useF12ShellT = () => useBundleT(F12_SHELL_MESSAGES);
