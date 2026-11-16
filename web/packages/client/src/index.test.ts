import { describe, expect, it } from "vitest";
import * as client from "./index";

describe("public surface", () => {
  it("exports the client, the event helper and the ported logic", () => {
    for (const name of ["createTangentClient", "subscribeEvents", "TangentError", "buildBranchTree", "buildBranchMapLayout", "describeBranchError", "normalizeChapters", "cardReducer", "planMove", "featureMode"]) {
      expect(client).toHaveProperty(name);
    }
  });
});
