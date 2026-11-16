import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOMAIN_ERROR_CODES, ERROR_TEXT_MAX, TangentError, errorFromResponse, extraNumber, hasErrorCode } from "./errors";

/** `TANGENT_DOMAIN_ERRORS_GO` points at another copy (e.g. a commit's, while the backend edits the working tree's). */
const DOMAIN_ERRORS_GO = process.env.TANGENT_DOMAIN_ERRORS_GO ?? fileURLToPath(new URL("../../../../domain/errors.go", import.meta.url));

describe("DOMAIN_ERROR_CODES", () => {
  it("lists exactly the codes domain/errors.go defines", () => {
    const source = readFileSync(DOMAIN_ERRORS_GO, "utf8");
    const goCodes = [...source.matchAll(/^\s*Code\w+\s*=\s*"(\w+)"/gm)].map((match) => match[1]);
    expect(goCodes.length).toBeGreaterThan(40);
    expect([...DOMAIN_ERROR_CODES].sort()).toEqual([...new Set(goCodes)].sort());
  });
});

describe("errorFromResponse", () => {
  it("splits the envelope into message, code and extra", () => {
    const error = errorFromResponse(409, "Conflict", JSON.stringify({ error: "moved", code: "parent_moved", movedMessages: 2, movedCards: 1 }));
    expect(error).toMatchObject({ status: 409, message: "moved", code: "parent_moved", extra: { movedMessages: 2, movedCards: 1 } });
    expect("error" in error.extra).toBe(false);
    expect("code" in error.extra).toBe(false);
  });

  it("copes with an envelope without code or message", () => {
    expect(errorFromResponse(404, "Not Found", "{}")).toMatchObject({ code: "", message: "Not Found" });
    expect(errorFromResponse(400, "", JSON.stringify({ error: "x", code: 7 }))).toMatchObject({ code: "", message: "x" });
  });

  it("quotes a non-JSON body only when it is text/plain, cut to ERROR_TEXT_MAX (review M2)", () => {
    expect(errorFromResponse(500, "", "boom\n", "text/plain").message).toBe("boom");
    expect(errorFromResponse(500, "", "boom\n").message).toBe("HTTP 500");
    expect(errorFromResponse(502, "Bad Gateway", "<html><body>nginx</body></html>", "text/html").message).toBe("Bad Gateway");
    expect(errorFromResponse(500, "", "[1,2]", "application/json").message).toBe("HTTP 500");
    expect(errorFromResponse(503, "Unavailable", "").message).toBe("Unavailable");
    const long = errorFromResponse(500, "", "字".repeat(ERROR_TEXT_MAX + 50), "Text/Plain; charset=utf-8").message;
    expect(Array.from(long)).toHaveLength(ERROR_TEXT_MAX + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("helpers", () => {
  it("reads numbers from extra and checks codes", () => {
    const error = new TangentError(409, "m", "branch_limit", { limit: 8, label: "x" });
    expect(extraNumber(error, "limit", 1)).toBe(8);
    expect(extraNumber(error, "label", 1)).toBe(1);
    expect(extraNumber(error, "missing", 3)).toBe(3);
    expect(hasErrorCode(error, "branch_limit")).toBe(true);
    expect(hasErrorCode(error, "tree_limit")).toBe(false);
    expect(hasErrorCode(new Error("x"), "branch_limit")).toBe(false);
  });
});
