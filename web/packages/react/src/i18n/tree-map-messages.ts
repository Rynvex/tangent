/**
 * F9 B.3's wording: the narrow screens' 「樹狀地圖」 entry in the structure
 * panel (lazily loaded, so its words travel with it).
 */
import { useBundleT, type MessageBundle } from "./bundle";

const en = {
  "structure.openTreeMap": "Tree map",
  "structure.openTreeMapHint": "Open the tree map (focus mode)",
} as const;

export type TreeMapMessageKey = keyof typeof en;

const zhTW: Record<TreeMapMessageKey, string> = {
  "structure.openTreeMap": "樹狀地圖",
  "structure.openTreeMapHint": "打開樹狀地圖（專注模式）",
};

const ja: Record<TreeMapMessageKey, string> = {
  "structure.openTreeMap": "ツリーマップ",
  "structure.openTreeMapHint": "ツリーマップを開く（フォーカスモード）",
};

export const TREE_MAP_MESSAGES: MessageBundle<TreeMapMessageKey> = { en, "zh-TW": zhTW, ja };

export const useTreeMapT = () => useBundleT(TREE_MAP_MESSAGES);
