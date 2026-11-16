import { describe, expect, it } from "vitest";
import { tangentKeys } from "./query-keys";

describe("tangentKeys", () => {
  const keys = tangentKeys({ baseUrl: "/api", tenant: "t1" });

  it("scopes every key by base url and tenant", () => {
    expect(keys.all).toEqual(["tangent", "/api", "t1", ""]);
    expect(keys.line("l1").slice(0, 4)).toEqual(keys.all);
    expect(tangentKeys({ baseUrl: "/api", tenant: "t2" }).line("l1")).not.toEqual(keys.line("l1"));
    expect(tangentKeys({ baseUrl: "/other", tenant: "t1" }).line("l1")).not.toEqual(keys.line("l1"));
  });

  it("nests line-scoped keys under the line so one invalidation reaches them", () => {
    const line = keys.line("l1");
    for (const key of [keys.lineView("l1"), keys.messages("l1"), keys.branches("l1", true), keys.branch("l1"), keys.notes("l1"), keys.chapters("l1"), keys.stream("l1"), keys.preview("l1", "hi")]) {
      expect(key.slice(0, line.length)).toEqual(line);
    }
  });

  it("separates list variants and normalizes the base url and a missing tenant", () => {
    expect(keys.lines({ archived: true })).not.toEqual(keys.lines({ archived: false }));
    expect(keys.branches("l1", true)).not.toEqual(keys.branches("l1", false));
    expect(keys.preview("l1", "a")).not.toEqual(keys.preview("l1", "b"));
    // Outlines and chapters of a tree sit under its root, whatever line asked.
    expect(keys.branches("root", true).slice(0, keys.branchesOf("root").length)).toEqual(keys.branchesOf("root"));
    expect(keys.chapters("root", "b1").slice(0, keys.chaptersOf("root").length)).toEqual(keys.chaptersOf("root"));
    // The line view is a leaf, so it never matches the prefix of another line key.
    expect(keys.lineView("l1")).not.toEqual(keys.line("l1"));
    expect(tangentKeys({ baseUrl: "/api/" }).all).toEqual(["tangent", "/api", "", ""]);
    expect(keys.capabilities()).toEqual(["tangent", "/api", "t1", "", "capabilities"]);
  });
});

describe("scopeKey (review M4)", () => {
  it("separates the cache of two signed-in identities on the same server and tenant", () => {
    const alice = tangentKeys({ baseUrl: "/api", tenant: "t1", scopeKey: "alice" });
    const bob = tangentKeys({ baseUrl: "/api", tenant: "t1", scopeKey: "bob" });
    expect(alice.all).toEqual(["tangent", "/api", "t1", "alice"]);
    expect(alice.messages("l1")).not.toEqual(bob.messages("l1"));
  });
});
