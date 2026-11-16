import { describe, expect, it } from "vitest";
import { composerSlot, type ComposerSlotInput } from "./composer-slot";

const OPEN: ComposerSlotInput = { readOnly: false, permissionsLoaded: true, lineLoaded: true, ended: false, branchLoaded: true, archived: false };

describe("composerSlot: what sits under the conversation", () => {
  it("offers the composer only on a loaded, open, writable line", () => {
    expect(composerSlot(OPEN)).toBe("composer");
  });

  it("never offers the composer while the line is still loading", () => {
    expect(composerSlot({ ...OPEN, lineLoaded: false })).toBe("none");
    expect(composerSlot({ ...OPEN, lineLoaded: false, branchLoaded: false })).toBe("none");
  });

  it("never offers the composer before the identity's permissions are known (a viewer would see it flash)", () => {
    expect(composerSlot({ ...OPEN, permissionsLoaded: false })).toBe("none");
    expect(composerSlot({ ...OPEN, permissionsLoaded: false, archived: true })).toBe("none");
  });

  it("shows the result bar for an ended branch, and nothing (never the composer) while its branch view loads", () => {
    expect(composerSlot({ ...OPEN, ended: true })).toBe("result");
    expect(composerSlot({ ...OPEN, ended: true, branchLoaded: false })).toBe("none");
    expect(composerSlot({ ...OPEN, ended: true, branchLoaded: false, archived: true })).toBe("none");
  });

  it("puts the read-only and archived bars first", () => {
    expect(composerSlot({ ...OPEN, readOnly: true, lineLoaded: false })).toBe("readOnly");
    expect(composerSlot({ ...OPEN, archived: true })).toBe("archived");
  });

  it("lets nothing interactive through for any still-loading combination", () => {
    for (const ended of [false, true])
      for (const archived of [false, true])
        for (const branchLoaded of [false, true]) {
          const slot = composerSlot({ readOnly: false, permissionsLoaded: true, lineLoaded: false, ended, branchLoaded, archived });
          expect(slot).toBe("none");
        }
  });
});
