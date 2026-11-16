import { describe, expect, it } from "vitest";
import { F8_SHELL_MESSAGES } from "./f8-shell-messages";

/** The list's and shortcut list's lazy wording (F8 S4, S5): both languages alike. */

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("F8 shell bundle", () => {
  it("has the same keys and slots in all languages, every text filled", () => {
    expect(Object.keys(F8_SHELL_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(F8_SHELL_MESSAGES.en).sort());
    expect(Object.keys(F8_SHELL_MESSAGES.ja).sort()).toEqual(Object.keys(F8_SHELL_MESSAGES.en).sort());
    for (const [key, text] of Object.entries(F8_SHELL_MESSAGES.en)) {
      const zh = F8_SHELL_MESSAGES["zh-TW"][key as keyof typeof F8_SHELL_MESSAGES.en];
      const ja = F8_SHELL_MESSAGES.ja[key as keyof typeof F8_SHELL_MESSAGES.en];
      expect(text, key).toBeTruthy();
      expect(zh, key).toBeTruthy();
      expect(ja, key).toBeTruthy();
      expect(slots(zh), key).toEqual(slots(text));
      expect(slots(ja), key).toEqual(slots(text));
    }
  });

  it("uses the glossary (紀要, never 筆記)", () => {
    for (const [key, text] of Object.entries(F8_SHELL_MESSAGES["zh-TW"])) expect(text, key).not.toContain("筆記");
  });
});
