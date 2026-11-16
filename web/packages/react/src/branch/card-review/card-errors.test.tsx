import { normalizeMessage, type BranchCard } from "@tangent/client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CardForm } from "./card-form";
import { strayErrors } from "./card-errors";

afterEach(cleanup);

/** A card with one entry in every list, so every row-level path has a row to land on. */
const CARD: BranchCard = {
  question: "q",
  conclusion: "c",
  evidence: [{ messageId: "b1", note: "n" }],
  impact: "i",
  openItems: ["o"],
  needsDecision: [{ branchClaim: "b", mainLineClaim: "m", mainLineMessageId: "p1" }],
  excerpts: [{ messageId: "b1", text: "x" }],
};
const MESSAGES = [normalizeMessage({ id: "b1", seq: 1, role: "assistant", content: "x" })];

/** Every field path `validateCard` or the server's `invalid_card` can name (domain/branch_card.go), plus an unknown one. */
const PATHS = [
  "question",
  "conclusion",
  "impact",
  "card",
  "evidence",
  "evidence[0]",
  "evidence[0].messageId",
  "evidence[0].note",
  "openItems",
  "openItems[0]",
  "needsDecision",
  "needsDecision[0]",
  "needsDecision[0].branchClaim",
  "needsDecision[0].mainLineClaim",
  "needsDecision[0].mainLineMessageId",
  "excerpts",
  "excerpts[0]",
  "excerpts[0].messageId",
  "excerpts[0].text",
  "excerpts[3].text",
  "something.new",
];

describe("CardForm shows every error the review can get (R2)", () => {
  it.each(PATHS)("%s", (path) => {
    render(<CardForm card={CARD} edit={() => undefined} errors={{ [path]: `problem at ${path}` }} branchMessages={MESSAGES} parentMessages={[]} />);
    expect(screen.getByText(`problem at ${path}`, { exact: false })).toBeVisible();
  });

  it("knows which paths no slot shows", () => {
    expect(strayErrors({ "excerpts[3].text": "a", question: "b", "excerpts[0]": "c", "x.y": "d" }, CARD)).toEqual([
      ["excerpts[3].text", "a"],
      ["x.y", "d"],
    ]);
  });
});
