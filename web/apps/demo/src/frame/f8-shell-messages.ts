/**
 * The F8 wording of the conversation list, its menu and the shortcut list
 * (S4, S5). Imported only by those lazy parts, so it travels with their
 * chunks instead of the main dictionary.
 */
import { useBundleT, type MessageBundle } from "@tangent/react";

const en = {
  // S5: the conversation menu and the list.
  "conv.rename": "Rename…",
  "conv.renameField": "Title of “{title}”",
  "conv.renameHint": "Enter saves · Esc gives up · {count} / {max}",
  "conv.renameEmpty": "The title can’t be empty.",
  "conv.renameFailed": "Not renamed: {reason}",
  "conv.renameArchived": "An archived conversation can’t be renamed.",
  "conv.renameTitle": "Rename the conversation",
  "conv.renameSave": "Save",
  "conv.renameCancel": "Cancel",
  "conv.pin": "Pin to top",
  "conv.unpin": "Unpin",
  "conv.pinLocal": "This device only",
  "conv.searchInTree": "Search this conversation",
  "conv.export": "Export…",
  "list.pinned": "Pinned",
  "list.review": "Review",
  "list.reviewCount": "Review, {count} open",
  "list.memory": "Memory",
  // S4: the shortcut list.
  "shortcuts.title": "Keyboard shortcuts",
  "shortcuts.description": "The keys as they are set now. Commands without keys are in the command palette.",
  "shortcuts.groupNav": "Navigation",
  "shortcuts.groupBranch": "Branches",
  "shortcuts.groupNotes": "Notes and parking",
  "shortcuts.groupFocus": "Focus mode",
  "shortcuts.firefox": "Not in Firefox",
  "shortcuts.firefoxNote": "Firefox keeps the keys marked “Not in Firefox” for itself; use the command palette ({palette}) there.",
  "shortcuts.none": "No keys are set.",
};

export type F8ShellMessageKey = keyof typeof en;

const zhTW: Record<F8ShellMessageKey, string> = {
  "conv.rename": "重新命名…",
  "conv.renameField": "「{title}」的標題",
  "conv.renameHint": "Enter 儲存・Esc 放棄・{count} / {max}",
  "conv.renameEmpty": "標題不能空白。",
  "conv.renameFailed": "沒有改成名稱：{reason}",
  "conv.renameArchived": "封存的對話不能改名。",
  "conv.renameTitle": "重新命名對話",
  "conv.renameSave": "儲存",
  "conv.renameCancel": "取消",
  "conv.pin": "置頂對話",
  "conv.unpin": "取消置頂",
  "conv.pinLocal": "只在這台裝置",
  "conv.searchInTree": "在對話內搜尋",
  "conv.export": "匯出…",
  "list.pinned": "置頂",
  "list.review": "回顧",
  "list.reviewCount": "回顧，{count} 項待處理",
  "list.memory": "記憶庫",
  "shortcuts.title": "快捷鍵",
  "shortcuts.description": "照目前的設定顯示。沒有按鍵的指令在命令面板裡。",
  "shortcuts.groupNav": "導覽",
  "shortcuts.groupBranch": "支線",
  "shortcuts.groupNotes": "紀要與停車",
  "shortcuts.groupFocus": "專注模式",
  "shortcuts.firefox": "Firefox 不可用",
  "shortcuts.firefoxNote": "標「Firefox 不可用」的按鍵在 Firefox 會被瀏覽器攔下，請改用命令面板（{palette}）。",
  "shortcuts.none": "目前沒有設定任何按鍵。",
};

const ja: Record<F8ShellMessageKey, string> = {
  "conv.rename": "名前を変更…",
  "conv.renameField": "「{title}」のタイトル",
  "conv.renameHint": "Enter で保存・Esc でキャンセル・{count} / {max}",
  "conv.renameEmpty": "タイトルを入力してください。",
  "conv.renameFailed": "名前を変更できませんでした：{reason}",
  "conv.renameArchived": "アーカイブ済みの会話は名前を変更できません。",
  "conv.renameTitle": "会話の名前を変更",
  "conv.renameSave": "保存",
  "conv.renameCancel": "キャンセル",
  "conv.pin": "上部にピン留め",
  "conv.unpin": "ピン留めを解除",
  "conv.pinLocal": "この端末のみ",
  "conv.searchInTree": "この会話内を検索",
  "conv.export": "エクスポート…",
  "list.pinned": "ピン留め",
  "list.review": "レビュー",
  "list.reviewCount": "レビュー（{count} 件未処理）",
  "list.memory": "メモリ",
  "shortcuts.title": "キーボードショートカット",
  "shortcuts.description": "現在有効なキー割り当てです。キー未設定のコマンドはコマンドパレットから実行できます。",
  "shortcuts.groupNav": "ナビゲーション",
  "shortcuts.groupBranch": "ブランチ",
  "shortcuts.groupNotes": "ノートと保留",
  "shortcuts.groupFocus": "フォーカスモード",
  "shortcuts.firefox": "Firefox では不可",
  "shortcuts.firefoxNote": "「Firefox では不可」のショートカットはブラウザ側に予約されているため、コマンドパレット（{palette}）をご利用ください。",
  "shortcuts.none": "キーが割り当てられていません。",
};

export const F8_SHELL_MESSAGES: MessageBundle<F8ShellMessageKey> = { en, "zh-TW": zhTW, ja };

/** The translator of the list, its menu and the shortcut list: their own strings, then the bundled dictionary. */
export const useShellT = () => useBundleT(F8_SHELL_MESSAGES);
