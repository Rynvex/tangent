/**
 * F17: the design's nine rounds of one mixed conversation (Claude Design
 * 2026-11-04, decision #1): CPU cooling (#1, #3, #5) broken by Firebase /
 * Supabase (#2, #6) and an AIO detour (#4), then a translation on its own (#7)
 * and case airflow (#8, #9). The built-in analysis (analyzeImportLocal) threads
 * them into §1 [#1, #3, #5], a branch [#2, #6] after #1, a branch [#4] after
 * #3, a separate conversation [#7] and §2 [#8, #9]; import-mindmap-layout.test.ts
 * checks that it still does. Every message is dated (Asia/Taipei afternoon).
 */

/** Question, answer and the round's time (HH:MM, Asia/Taipei, 2026-11-03). */
export const MINDMAP_ROUNDS: ReadonlyArray<readonly [string, string, string]> = [
  ["如果電腦平常都不關，CPU 散熱膏多久換一次？", "一般矽脂大約 2～3 年會乾裂、導熱變差；長開不關機、溫度常在 70°C 以上的話，建議 1～2 年檢查一次。待機溫度比以前高 8～10°C，就是該換的訊號。", "13:42"],
  ["Firebase 是什麼？跟 Supabase 差在哪？", "兩個都是後端即服務（BaaS）。Firebase 是 Google 的，資料庫是 NoSQL 的 Firestore；Supabase 是開源的，底層是 Postgres，可以直接寫 SQL。", "13:55"],
  ["相變導熱片 PTM7950 跟傳統散熱膏比起來，哪個比較適合長開不關機的電腦？", "PTM7950 在高溫下會從固態轉為半液態填補微孔，沒有傳統矽脂的 pump-out 效應，長時間高負載下溫度更穩定。缺點是剛裝好要先跑幾次高溫循環才會完全貼合，價格也比較高。", "14:18"],
  ["一體式水冷和雙塔風冷，哪個壽命比較長？", "雙塔風冷只有風扇會壞，換風扇就好；一體式水冷的幫浦與冷排液體會老化，大多保固 5～6 年。", "14:25"],
  ["換 PTM7950 要注意什麼？", "尺寸要比 CPU 頂蓋略大，兩面保護膜都要撕；裝好後跑 20 分鐘燒機讓它熔化貼合。拆下來就不能重複使用。", "14:31"],
  ["Supabase 的免費額度夠個人專案用嗎？", "免費方案有 500 MB 資料庫與 1 GB 檔案儲存，一週沒有活動會暫停；個人專案通常夠用。", "14:40"],
  ["幫我翻譯這封日文商用書信", "以下是譯文：「承蒙貴公司長期關照……」", "15:02"],
  ["機殼風道要前進後出，還是下進上出？", "大部分直立機殼用前進後出加頂部排風最穩。", "15:30"],
  ["機殼正壓和負壓哪個比較不容易積灰？", "正壓比較不容易積灰，空氣只從有濾網的進風口進來。", "15:41"],
];

/** "13:42" on 2026-11-03 in Asia/Taipei, `minutes` later, as UTC ISO. */
const isoAt = (clock: string, minutes = 0): string => {
  const [h, m] = clock.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 3, h! - 8, m! + minutes)).toISOString();
};

/** The nine rounds as one generic JSON conversation, every message dated (a reply a minute after its question). */
export function mindmapConversation(): { title: string; messages: Array<{ role: "user" | "assistant"; content: string; createdAt: string }> } {
  return {
    title: "電腦散熱與硬體維護雜談",
    messages: MINDMAP_ROUNDS.flatMap(([question, answer, clock]) => [
      { role: "user" as const, content: question, createdAt: isoAt(clock) },
      { role: "assistant" as const, content: answer, createdAt: isoAt(clock, 1) },
    ]),
  };
}
