import { describe, expect, it } from "vitest";
import { cleanSuggestedTags, filterSuggestedTags, titleTopicWords } from "./suggested-tags";

describe("titleTopicWords", () => {
  it("cuts the title at punctuation, ASCII, connectives and function characters", () => {
    expect(titleTopicWords("微分幾何在物理研究中的應用")).toEqual(["微分幾何", "物理研究", "應用"]);
    expect(titleTopicWords("Postgres MVCC 與索引設計")).toEqual(["索引設計"]);
    expect(titleTopicWords("為什麼容器連不上宿主機？")).toEqual(["容器連不上宿主機"]);
    expect(titleTopicWords("微分幾何在研究什麼?")).toEqual(["微分幾何", "研究"]);
    expect(titleTopicWords("一二三四五六七八九")).toEqual([]);
  });
});

describe("filterSuggestedTags", () => {
  it("joins the pairs of a title word and drops fragments across words (the dev server's real example)", () => {
    expect(filterSuggestedTags(["微分", "分幾", "幾何", "何在", "研究"], "微分幾何在物理研究中的應用")).toEqual(["微分幾何", "研究"]);
  });

  it("joins a chain of pairs the title does not name and drops pairs at a function character", () => {
    expect(filterSuggestedTags(["微分", "分幾", "幾何", "何在", "研究"], "一些筆記")).toEqual(["微分幾何", "研究"]);
  });

  it("keeps ASCII and number words, tags used elsewhere, and leaves out the line's own tags", () => {
    expect(filterSuggestedTags(["postgresql", "機制", "docker", "容器", "raid10"], "PostgreSQL MVCC 與鎖定機制討論", ["容器"], ["docker"])).toEqual(["postgresql", "機制", "容器", "raid10"]);
  });

  it("drops pairs that open or close with a question word (要怎、怎麼)", () => {
    expect(filterSuggestedTags(["索引", "要怎", "租戶"], "Postgres MVCC 與索引設計")).toEqual(["索引", "租戶"]);
  });

  it("normalises and removes repeats", () => {
    expect(filterSuggestedTags(["#Postgres", "postgres", " ", "MVCC"], "")).toEqual(["postgres", "mvcc"]);
  });

  it("keeps an existing tag even when it looks like a fragment", () => {
    expect(filterSuggestedTags(["何在"], "微分幾何在研究", ["何在"])).toEqual(["何在"]);
  });

  it("stops a chain at six characters (as domain.cleanSuggestedTags)", () => {
    expect(filterSuggestedTags(["一二", "二三", "三四", "四五", "五六", "六七", "七八"], "")).toEqual(["一二三四五六", "六七八"]);
  });

  it("chains over a dropped fragment or an own tag, so cleaning again changes nothing (as domain.cleanSuggestedTags)", () => {
    expect(filterSuggestedTags(["微分", "何在", "分幾"], "")).toEqual(["微分幾"]);
    expect(filterSuggestedTags(["微分幾"], "")).toEqual(["微分幾"]);
    expect(filterSuggestedTags(["甲乙", "乙丙", "丙丁"], "", [], ["乙丙"])).toEqual(["甲乙", "丙丁"]);
  });

  it("leaves out a joined word that is the line's own tag", () => {
    expect(filterSuggestedTags(["微分", "分幾", "幾何", "研究"], "微分幾何在研究什麼?", [], ["微分幾何"])).toEqual(["研究"]);
  });

  it("changes nothing when the tags are already clean (the server cleans them since B18.1)", () => {
    const cases: Array<[string[], string, string[], string[]]> = [
      [["微分", "分幾", "幾何", "何在", "研究"], "微分幾何在物理研究中的應用", [], []],
      [["微分", "分幾", "幾何", "何在", "研究"], "一些筆記", [], []],
      [["postgresql", "機制", "docker", "容器", "raid10"], "PostgreSQL MVCC 與鎖定機制討論", ["容器"], ["docker"]],
      [["一二", "二三", "三四", "四五", "五六", "六七", "七八"], "", [], []],
    ];
    for (const [raw, title, used, own] of cases) {
      const once = filterSuggestedTags(raw, title, used, own);
      expect(filterSuggestedTags(once, title, used, own)).toEqual(once);
    }
    expect(filterSuggestedTags(["微分幾何", "研究", "代數", "曲線", "曲面"], "微分幾何在研究什麼?")).toEqual(["微分幾何", "研究", "代數", "曲線", "曲面"]);
  });
});

describe("cleanSuggestedTags", () => {
  it("stops at the limit", () => {
    expect(cleanSuggestedTags(["a1", "b2", "c3"], "", [], [], 2)).toEqual(["a1", "b2"]);
  });
});

describe("a tenant tag inside a title word (B19, as domain.cleanSuggestedTags)", () => {
  const title = "微分幾何在物理研究中的應用";
  const orders: Record<string, string[]> = {
    "the tenant tag after 微分": ["微分", "分幾", "幾何", "研究"],
    "the tenant tag before 微分": ["幾何", "微分", "分幾", "研究"],
    "the tenant tag last": ["微分", "分幾", "研究", "幾何"],
  };
  for (const [name, raw] of Object.entries(orders)) {
    it(`${name}: joins 微分幾何, never 微分幾, and keeps 幾何 on its own`, () => {
      // Act
      const got = filterSuggestedTags(raw, title, ["幾何"]);
      // Assert
      expect(got).toContain("微分幾何");
      expect(got).toContain("幾何");
      expect(got).toContain("研究");
      expect(got).not.toContain("微分幾");
      expect(got).not.toContain("分幾");
      expect(filterSuggestedTags(got, title, ["幾何"])).toEqual(got);
    });
  }
});
