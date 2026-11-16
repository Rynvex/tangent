import { normalizeBranchView, type Note } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { noteSourceLink } from "./note-source";

const t = createTranslator("en");
const note = (over: Partial<Note>): Note => ({
  id: "n", section: "fact", text: "x", status: "active", sourceLineId: "", sourceMessageId: "", sourceCardMessageId: "",
  supersededBy: "", createdBy: "u", createdAt: "", updatedAt: "", ...over,
});
const branch = normalizeBranchView({ lineId: "b1", parentLineId: "root", rootLineId: "root", kind: "investigate", status: "merged", purpose: "ECC or not", origin: "button" });
const ctx = { rootLineId: "root", branches: [branch], mainNumbers: new Map([["m3", 3]]), t };

describe("noteSourceLink", () => {
  it("names a main-line message by its #n and links to it", () => {
    expect(noteSourceLink(note({ sourceLineId: "root", sourceMessageId: "m3" }), ctx)).toEqual({ label: "Main line #3", lineId: "root", messageId: "m3" });
    expect(noteSourceLink(note({ sourceLineId: "root", sourceMessageId: "m9" }), ctx)).toEqual({ label: "Main line", lineId: "root", messageId: "m9" });
    expect(noteSourceLink(note({ sourceLineId: "root" }), ctx)).toEqual({ label: "Main line", lineId: "root" });
  });

  it("names a branch by its kind and purpose", () => {
    expect(noteSourceLink(note({ sourceLineId: "b1", sourceMessageId: "bm1" }), ctx)).toEqual({ label: "Investigate · ECC or not", lineId: "b1", messageId: "bm1" });
  });

  it("links a conclusion card's note to the card on the branch's parent", () => {
    expect(noteSourceLink(note({ sourceLineId: "b1", sourceCardMessageId: "c1" }), ctx)).toEqual({ label: "Conclusion card · ECC or not", lineId: "root", messageId: "c1" });
  });

  it("prefers the label the server stored with the note, keeping the link (B8 sourceLabel)", () => {
    expect(noteSourceLink(note({ sourceLineId: "root", sourceMessageId: "m3", sourceLabel: "主線 #8" }), ctx)).toEqual({ label: "主線 #8", lineId: "root", messageId: "m3" });
    expect(noteSourceLink(note({ sourceLineId: "b1", sourceCardMessageId: "c1", sourceLabel: "結論卡・ECC or not" }), ctx)).toEqual({ label: "結論卡・ECC or not", lineId: "root", messageId: "c1" });
  });

  it("keeps the stored label when the source is gone (a cleared aside), without a link", () => {
    expect(noteSourceLink(note({ sourceLineId: "gone", sourceLabel: "Aside · scrub" }), ctx)).toEqual({ label: "Aside · scrub", lineId: null });
    expect(noteSourceLink(note({ sourceLineId: "gone" }), ctx)).toEqual({ label: "Source cleared", lineId: null });
    expect(noteSourceLink(note({}), ctx)).toBeNull();
  });
});
