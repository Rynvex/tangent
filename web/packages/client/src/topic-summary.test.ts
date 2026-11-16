import { describe, expect, it } from "vitest";
import { summarizeTopic } from "./topic-summary";

describe("summarizeTopic (F11 §2)", () => {
  it("keeps a short question, without its end mark", () => {
    expect(summarizeTopic("ZFS 和 Btrfs 差在哪？")).toBe("ZFS 和 Btrfs 差在哪");
  });

  it("takes the last question after a long background", () => {
    const text = "我家有一台 NAS，放了四顆 4TB 的碟，目前用 RAID5。最近看到很多人說 RAID5 重建風險很高。我也有異地備份。那如果改成 RAID10，容量和安全性要怎麼取捨？";
    expect(summarizeTopic(text)).toBe("改成 RAID10，容量和安全性要怎麼取捨");
  });

  it("takes the first real sentence when nothing asks", () => {
    expect(summarizeTopic("今天把備份腳本改好了。順便整理一下排程。")).toBe("今天把備份腳本改好了");
  });

  it("drops code, links, quotes, headings and list marks", () => {
    const text = "> 引用別人的話\n```sh\nrclone sync /a b2:/a\n```\n看 https://example.com/docs 之後：\n- **rclone 的 --fast-list 有什麼用？**";
    expect(summarizeTopic(text)).toBe("rclone 的 --fast-list 有什麼用");
  });

  it("drops polite openings and the question templates' tails", () => {
    expect(summarizeTopic("我想請問一下，CAP 定理是什麼意思？")).toBe("CAP 定理是什麼意思");
    expect(summarizeTopic("什麼是「豪斯多夫維度」？請用簡單好懂的方式解釋，並舉一個例子。")).toBe("什麼是「豪斯多夫維度」");
    expect(summarizeTopic("為什麼說「碎形維度可以不是整數」？請詳細說明背後的邏輯與原因。")).toBe("「碎形維度可以不是整數」");
  });

  it("finds English questions too", () => {
    expect(summarizeTopic("We run nightly backups. Disk use grew a lot.\nWhich retention policy should we use?")).toBe("Which retention policy should we use");
  });

  it("of one long sentence, takes the part that asks", () => {
    expect(summarizeTopic("請問在預算三萬元、需要長時間開機、還要兼顧低噪音與省電的前提下，家用 NAS 該選哪一種硬體架構比較好？")).toBe("家用 NAS 該選哪一種硬體架構比較好");
    expect(summarizeTopic("我有一個 Go 服務跑在 k8s，最近常常 OOM，已經看過 pprof 但還是看不出來，請問該怎麼排查記憶體洩漏？謝謝")).toBe("該怎麼排查記憶體洩漏");
  });

  it("splits English sentences at a period before a space", () => {
    expect(summarizeTopic("I use Go with Postgres. The server crashes under load. How do I find the bottleneck?")).toBe("How do I find the bottleneck");
  });

  it("cuts a long topic at a soft break with …", () => {
    const text = "在預算三萬元、需要長時間開機、還要兼顧低噪音與省電、又希望之後能擴充到八顆硬碟的前提下挑選家用 NAS 硬體架構";
    const topic = summarizeTopic(text, 36);
    expect(Array.from(topic).length).toBeLessThanOrEqual(36);
    expect(topic.endsWith("…")).toBe(true);
    expect(topic.startsWith("在預算三萬元")).toBe(true);
    expect(topic).not.toMatch(/[，、]…$/);
  });

  it("keeps a Markdown link's text and the question after an unclosed fence", () => {
    expect(summarizeTopic("[docs](https://a.b/c) 怎麼用 hooks？")).toBe("docs 怎麼用 hooks");
    expect(summarizeTopic("```\ncode\n怎麼辦才好？")).toBe("怎麼辦才好");
  });

  it("gives nothing for only code or links", () => {
    expect(summarizeTopic("```\nls -la\n```")).toBe("");
    expect(summarizeTopic("https://example.com")).toBe("");
    expect(summarizeTopic("   ")).toBe("");
  });

  it("keeps numbers that only look like list marks", () => {
    expect(summarizeTopic("1.5 倍的冗餘夠不夠？")).toBe("1.5 倍的冗餘夠不夠");
  });
});
