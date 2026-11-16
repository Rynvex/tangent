import { describe, expect, it } from "vitest";
import { settledFor } from "./hooks";

describe("settledFor: a debounced value never outlives the key it was typed for", () => {
  it("uses the settled value while it belongs to the current key", () => {
    expect(settledFor({ key: "a", value: "old a" }, "a", "new a")).toBe("old a");
  });

  it("switches to the new key's live value at once, never the previous key's settled one", () => {
    expect(settledFor({ key: "a", value: "draft for a" }, "b", "draft for b")).toBe("draft for b");
    expect(settledFor({ key: "a", value: "draft for a" }, null, "")).toBe("");
  });
});
