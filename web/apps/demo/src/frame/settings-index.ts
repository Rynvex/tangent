/**
 * The Settings page's map (G2), pure: its categories in their three nav
 * groups, every setting row with the group it sits in, and the search over
 * names, descriptions and keywords. The panels render from this list, so a
 * row that exists is a row the search finds.
 */
import type { PrefChoiceKey, PrefFlagKey } from "./prefs";
import type { SettingsMessageKey } from "./settings-messages";

export const SETTINGS_CATEGORIES = ["general", "appearance", "chat", "keybindings", "providers", "threads", "maintenance", "archive", "about"] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const isSettingsCategory = (value: string): value is SettingsCategory => (SETTINGS_CATEGORIES as readonly string[]).includes(value);

export interface SettingsNavGroup {
  titleKey: SettingsMessageKey;
  categories: readonly SettingsCategory[];
}

/** The side navigation, after T3 Code's order, with Tangent's own categories. */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  { titleKey: "g2.navBasic", categories: ["general", "appearance", "chat", "keybindings"] },
  { titleKey: "g2.navAgents", categories: ["providers", "threads"] },
  { titleKey: "g2.navSystem", categories: ["maintenance", "archive", "about"] },
];

export const categoryTitleKey = (category: SettingsCategory): SettingsMessageKey => `g2.cat.${category}`;

/** How a row's control is drawn: a preference's choices, an on / off preference, or a part of its own. */
export type SettingControl = { kind: "choice"; pref: PrefChoiceKey; order?: readonly (string | number)[] } | { kind: "flag"; pref: PrefFlagKey } | { kind: "custom" };

export interface SettingEntry {
  /** Stable id; the row carries it as `data-setting`. */
  id: string;
  category: SettingsCategory;
  /** The card the row sits in. */
  group: SettingsMessageKey;
  titleKey: SettingsMessageKey;
  descKey?: SettingsMessageKey;
  control: SettingControl;
  /** Extra search words, all locales (what a user might type that the title does not say). */
  keywords: string;
}

const choice = (pref: PrefChoiceKey, order?: readonly (string | number)[]): SettingControl => ({ kind: "choice", pref, ...(order ? { order } : {}) });
const flag = (pref: PrefFlagKey): SettingControl => ({ kind: "flag", pref });
const CUSTOM: SettingControl = { kind: "custom" };

export const SETTINGS_ENTRIES: readonly SettingEntry[] = [
  // General.
  { id: "threadNotifications", category: "general", group: "g2.group.notifications", titleKey: "g2.threadNotifications", descKey: "g2.threadNotifications.desc", control: choice("threadNotifications"), keywords: "notify sound chime desktop background 通知 提示音 背景 桌面 サウンド デスクトップ バックグラウンド" },
  { id: "inAppNotifications", category: "general", group: "g2.group.notifications", titleKey: "g2.inAppNotifications", descKey: "g2.inAppNotifications.desc", control: flag("inAppNotifications"), keywords: "toast reply 提示 回覆 トースト 返信" },
  { id: "activityBadges", category: "general", group: "g2.group.sidebar", titleKey: "g2.activityBadges", descKey: "g2.activityBadges.desc", control: flag("activityBadges"), keywords: "unread waiting count list badge 未讀 等待 清單 徽章 未読 待機 バッジ" },
  { id: "confirmUnpin", category: "general", group: "g2.group.confirmations", titleKey: "g2.confirmUnpin", descKey: "g2.confirmUnpin.desc", control: flag("confirmUnpin"), keywords: "pin 置頂 釘選 ピン留め" },
  { id: "confirmArchive", category: "general", group: "g2.group.confirmations", titleKey: "g2.confirmArchive", descKey: "g2.confirmArchive.desc", control: flag("confirmArchive"), keywords: "archive 封存 アーカイブ" },
  { id: "confirmDelete", category: "general", group: "g2.group.confirmations", titleKey: "g2.confirmDelete", descKey: "g2.confirmDelete.desc", control: flag("confirmDelete"), keywords: "delete remove 刪除 削除" },
  { id: "timeFormat", category: "general", group: "g2.group.formatting", titleKey: "g2.timeFormat", descKey: "g2.timeFormat.desc", control: choice("timeFormat", ["auto", "12h", "24h"]), keywords: "clock am pm hour 時鐘 上午 下午 小時 時計 時刻" },
  { id: "language", category: "general", group: "g2.group.formatting", titleKey: "g2.language", descKey: "g2.language.desc", control: choice("language"), keywords: "locale chinese english japanese 中文 英文 日文 語系 日本語 英語 中国語 言語" },
  // Appearance.
  { id: "theme", category: "appearance", group: "g2.group.theme", titleKey: "g2.theme", descKey: "g2.theme.desc", control: choice("theme", ["light", "dark", "system"]), keywords: "dark light mode colour color 深色 淺色 暗色 配色 ライト ダーク カラー テーマ" },
  { id: "chatWidth", category: "appearance", group: "g2.group.layout", titleKey: "g2.chatWidth", descKey: "g2.chatWidth.desc", control: choice("chatWidth"), keywords: "column wide full reading 欄寬 寬度 全寬 カラム 幅 ワイド フル" },
  { id: "readingFont", category: "appearance", group: "g2.group.typography", titleKey: "g2.readingFont", descKey: "g2.readingFont.desc", control: choice("readingFont"), keywords: "serif sans typeface 襯線 字型 フォント 明朝 ゴシック" },
  { id: "codeFontSize", category: "appearance", group: "g2.group.typography", titleKey: "g2.codeFontSize", descKey: "g2.codeFontSize.desc", control: choice("codeFontSize", ["sm", "md", "lg"]), keywords: "monospace size 等寬 大小 等幅 サイズ コード" },
  { id: "codeWrap", category: "appearance", group: "g2.group.typography", titleKey: "g2.codeWrap", descKey: "g2.codeWrap.desc", control: flag("codeWrap"), keywords: "wrap scroll line 折行 換行 捲動 折り返し スクロール" },
  { id: "renderMath", category: "appearance", group: "g2.group.rendering", titleKey: "g2.renderMath", descKey: "g2.renderMath.desc", control: flag("renderMath"), keywords: "latex formula dollar katex 公式 數學 金額 数式 ドル" },
  { id: "costThreshold", category: "appearance", group: "g2.group.rendering", titleKey: "g2.costThreshold", descKey: "g2.costThreshold.desc", control: choice("costThreshold", [0.02, 0.05, 0.1, "off"]), keywords: "price usd token money 費用 價格 金額 コスト 料金" },
  // Chat.
  { id: "sendShortcut", category: "chat", group: "g2.group.composer", titleKey: "g2.sendShortcut", descKey: "g2.sendShortcut.desc", control: choice("sendShortcut"), keywords: "enter ctrl cmd newline submit 送出 換行 輸入 送信 改行" },
  { id: "streamResponses", category: "chat", group: "g2.group.composer", titleKey: "g2.streamResponses", descKey: "g2.streamResponses.desc", control: flag("streamResponses"), keywords: "stream token live typing 串流 即時 ストリーミング" },
  { id: "followUp", category: "chat", group: "g2.group.composer", titleKey: "g2.followUp", descKey: "g2.followUp.desc", control: choice("followUp"), keywords: "stop interrupt queue 停止 打斷 追問 割り込み" },
  { id: "asideDefault", category: "chat", group: "g2.group.branching", titleKey: "g2.asideDefault", descKey: "g2.asideDefault.desc", control: choice("asideDefault"), keywords: "aside quick question keep discard 順口問 秒問 保留 丟掉 ちょっと質問 破棄" },
  { id: "expandCards", category: "chat", group: "g2.group.branching", titleKey: "g2.expandCards", descKey: "g2.expandCards.desc", control: flag("expandCards"), keywords: "card conclusion collapse expand 結論卡 展開 收合 結論カード 折りたたみ" },
  // The pages with parts of their own: one row each, so the search leads there.
  { id: "keybindings", category: "keybindings", group: "g2.cat.keybindings", titleKey: "g2.cat.keybindings", descKey: "g2.keys.hint", control: CUSTOM, keywords: "shortcut hotkey keyboard rebind record 快捷鍵 熱鍵 鍵盤 按鍵 ショートカット キーボード キー割り当て" },
  { id: "providers", category: "providers", group: "g2.providers", titleKey: "g2.providers", descKey: "g2.providers.desc", control: CUSTOM, keywords: "model claude codex gemini openai anthropic cli api key favourite favorite hide 模型 常用 隱藏 金鑰 モデル お気に入り 非表示 キー" },
  { id: "conversationModel", category: "threads", group: "g2.group.thisConversation", titleKey: "g2.group.thisConversation", control: CUSTOM, keywords: "model provider this conversation 模型 這個對話 モデル この会話" },
  { id: "defaultModel", category: "threads", group: "g2.group.newConversations", titleKey: "g2.defaultModel", descKey: "g2.defaultModel.desc", control: CUSTOM, keywords: "new conversation default model 新對話 預設 模型 新しい会話 既定 モデル" },
  { id: "defaultEffort", category: "threads", group: "g2.group.newConversations", titleKey: "g2.defaultEffort", descKey: "g2.defaultEffort.desc", control: CUSTOM, keywords: "reasoning effort thinking depth 思考 深度 推理 推論" },
  { id: "features", category: "threads", group: "g2.features", titleKey: "g2.features", descKey: "g2.features.desc", control: CUSTOM, keywords: "feature preset mode manual suggest auto TANGENT_FEATURES 功能 預設組 模式 機能 プリセット" },
  { id: "exportSettings", category: "maintenance", group: "g2.group.backup", titleKey: "g2.exportSettings", descKey: "g2.exportSettings.desc", control: CUSTOM, keywords: "backup download json share 備份 下載 分享 バックアップ ダウンロード 共有" },
  { id: "importSettings", category: "maintenance", group: "g2.group.backup", titleKey: "g2.importSettings", descKey: "g2.importSettings.desc", control: CUSTOM, keywords: "restore upload json 還原 上傳 復元 アップロード" },
  { id: "resetPrefs", category: "maintenance", group: "g2.group.reset", titleKey: "g2.resetPrefs", descKey: "g2.resetPrefs.desc", control: CUSTOM, keywords: "defaults factory 預設值 還原 既定値 リセット" },
  { id: "clearLocal", category: "maintenance", group: "g2.group.reset", titleKey: "g2.clearLocal", descKey: "g2.clearLocal.desc", control: CUSTOM, keywords: "cache draft storage localStorage 快取 草稿 暫存 キャッシュ 下書き 消去" },
  { id: "connection", category: "maintenance", group: "g2.group.connection", titleKey: "g2.connection", descKey: "g2.connection.desc", control: CUSTOM, keywords: "server sse baseurl status read only 伺服器 連線 狀態 唯讀 サーバー 接続 状態 読み取り専用" },
  { id: "archive", category: "archive", group: "g2.archive", titleKey: "g2.archive", descKey: "g2.archive.desc", control: CUSTOM, keywords: "archived restore unarchive delete 封存 解除封存 還原 刪除 アーカイブ 復元 削除" },
  { id: "about", category: "about", group: "g2.about", titleKey: "g2.about", descKey: "g2.about.tagline", control: CUSTOM, keywords: "version license mit github docs 版本 授權 文件 バージョン ライセンス ドキュメント" },
];

/** A category's entries in order. */
export function entriesOf(category: SettingsCategory): SettingEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.category === category);
}

/** A category's entries under their cards, in first-seen order. */
export function groupsOf(category: SettingsCategory): { group: SettingsMessageKey; entries: SettingEntry[] }[] {
  const groups: { group: SettingsMessageKey; entries: SettingEntry[] }[] = [];
  for (const entry of entriesOf(category)) {
    const last = groups.find((item) => item.group === entry.group);
    if (last) last.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}

export const entryById = (id: string): SettingEntry | undefined => SETTINGS_ENTRIES.find((entry) => entry.id === id);

type Translate = (key: SettingsMessageKey) => string;

/**
 * The entries matching every word of `query` (case-insensitive) in their
 * name, description, card, category or keywords, in the page's order; none
 * for an empty query.
 */
export function searchSettings(query: string, t: Translate, entries: readonly SettingEntry[] = SETTINGS_ENTRIES): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return entries.filter((entry) => {
    const haystack = [t(entry.titleKey), entry.descKey ? t(entry.descKey) : "", t(entry.group), t(categoryTitleKey(entry.category)), entry.keywords, entry.id].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
