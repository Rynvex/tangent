/**
 * The outline's grouped ended branches (F9 B.4): the group rows and the
 * toggle. Only the outline uses them, so they travel with its chunk.
 * The four leaf kinds' names are the main dictionary's (`leaf.kind.*`).
 */
import { useBundleT, type MessageBundle } from "./bundle";

const en = {
  "outlineGroups.other": "Other",
  "outlineGroups.count": "{count} ended",
  "outlineGroups.groupLabel": "{kind}: {count} ended branches",
  "outlineGroups.group": "Group the ended branches by how they ended",
  "outlineGroups.showAll": "Show all {count} ended branches",
} as const;

export type OutlineGroupsMessageKey = keyof typeof en;

const zhTW: Record<OutlineGroupsMessageKey, string> = {
  "outlineGroups.other": "其他",
  "outlineGroups.count": "{count} 條已結束",
  "outlineGroups.groupLabel": "{kind}：{count} 條已結束的支線",
  "outlineGroups.group": "收合已結束支線（依收尾類型分組）",
  "outlineGroups.showAll": "展開全部已結束支線（{count} 條）",
};

const ja: Record<OutlineGroupsMessageKey, string> = {
  "outlineGroups.other": "その他",
  "outlineGroups.count": "{count} 件終了",
  "outlineGroups.groupLabel": "{kind}：{count} 件の終了済みブランチ",
  "outlineGroups.group": "終了済みブランチを完了種別でグループ化",
  "outlineGroups.showAll": "すべての終了済みブランチを表示（{count} 件）",
};

export const OUTLINE_GROUPS_MESSAGES: MessageBundle<OutlineGroupsMessageKey> = { en, "zh-TW": zhTW, ja };

/** The translator of the outline's groups: their own strings, then the bundled dictionary. */
export const useOutlineGroupsT = () => useBundleT(OUTLINE_GROUPS_MESSAGES);
