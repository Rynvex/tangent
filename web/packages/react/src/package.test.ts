import { describe, expect, it } from "vitest";
import pkg from "../package.json";

describe("package manifest (review M9)", () => {
  it("declares React and TanStack Query as caret peer ranges, never catalog pins", () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      expect(range, name).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@tanstack/react-query", "react", "react-dom"]);
  });

  it("depends only on what it uses: the client, Base UI, icons and the Markdown stack (F1); fonts live in @tangent/fonts (F0 review M13)", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@base-ui/react",
      "@tangent/client",
      "highlight.js",
      "katex",
      "lowlight",
      "lucide-react",
      "react-markdown",
      "remark-gfm",
      "remark-math",
    ]);
  });

  it("marks its CSS as a side effect so bundlers keep `import \"@tangent/react/styles.css\"`", () => {
    expect(pkg.sideEffects).toEqual(["*.css"]);
  });
});
