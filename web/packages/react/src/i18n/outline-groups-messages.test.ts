import { describe, expect, it } from "vitest";
import { en } from "./en";
import { enSettings } from "./en.settings";
import { createBundleTranslator } from "./bundle";
import { createTranslator } from "./index";
import { OUTLINE_GROUPS_MESSAGES } from "./outline-groups-messages";

const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("the outline groups bundle (F9 B.4: loads with the outline)", () => {
  it("has the same keys and slots in all languages, none of the main dictionary's, and no 筆記", () => {
    expect(Object.keys(OUTLINE_GROUPS_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(OUTLINE_GROUPS_MESSAGES.en).sort());
    expect(Object.keys(OUTLINE_GROUPS_MESSAGES.ja).sort()).toEqual(Object.keys(OUTLINE_GROUPS_MESSAGES.en).sort());
    for (const [key, text] of Object.entries(OUTLINE_GROUPS_MESSAGES.en)) {
      expect(slots(OUTLINE_GROUPS_MESSAGES["zh-TW"][key as keyof typeof OUTLINE_GROUPS_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(OUTLINE_GROUPS_MESSAGES.ja[key as keyof typeof OUTLINE_GROUPS_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn({ ...en, ...enSettings }, key), key).toBe(false);
    }
    for (const text of Object.values(OUTLINE_GROUPS_MESSAGES["zh-TW"])) expect(text).not.toContain("筆記");
  });

  it("names the toggle as the design does and borrows the leaf kinds from the main dictionary", () => {
    const t = createBundleTranslator(OUTLINE_GROUPS_MESSAGES, "zh-TW", {}, createTranslator("zh-TW"));
    expect(t("outlineGroups.group")).toBe("收合已結束支線（依收尾類型分組）");
    expect(t("outlineGroups.groupLabel", { kind: t("leaf.kind.decision"), count: 3 })).toBe("決定：3 條已結束的支線");
  });
});
