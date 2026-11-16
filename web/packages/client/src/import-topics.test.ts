import { describe, expect, it } from "vitest";
import { IMPORT_MAX_BRANCH_MESSAGES } from "./b18-routes";
import { geminiCombinedSample, INTERLEAVED_ROUNDS, interleavedCombinedExport, longCombinedExport } from "./import-combined-fixtures";
import { parseImport, type ParsedConversation, type ParsedImport, type ParsedMessage } from "./import-parsers";
import {
  continuesTopic,
  groupTurns,
  hasReferent,
  isReportBack,
  splitByTopicShifts,
  splitOverLimit,
  startsAsFollowUp,
  startsAsShift,
  termWeights,
  threadByTopicShifts,
  threadUnits,
  TOPIC_LONG_MIN_MESSAGES,
  topicTerms,
} from "./import-topics";
import { orderedTerms } from "./text-terms";

const parse = (value: unknown, fileName = "export.json"): ParsedImport => {
  const result = parseImport(JSON.stringify(value), { fileName });
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.value;
};
const byTime = (list: readonly ParsedConversation[]) => [...list].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
const roundsOf = (questions: readonly string[], reply: (n: number) => string = (n) => `answer ${n}`): ParsedMessage[] =>
  questions.flatMap((question, n) => [
    { externalId: `q${n}`, role: "user" as const, content: question, versions: 1 },
    { externalId: `a${n}`, role: "assistant" as const, content: reply(n), versions: 1 },
  ]);

describe("topic words", () => {
  it("are decompose's words plus two-letter acronyms, without function pairs, digits or two-letter stopwords", () => {
    // Arrange / Act
    const words = topicTerms("如果有UI的話PRD可以畫出來, 但如果是 algorithm 呢? AI is ok in 2026");
    // Assert
    expect(words).toEqual(["ui", "prd", "畫出", "出來", "algorithm", "ai"]);
    expect(topicTerms("firebase是什麼?")).toEqual(["firebase"]);
    expect(topicTerms("PRD一般是對內還對外的?")).toEqual(["prd", "對內", "對外"]);
  });

  it("leave decompose's own words as they were (three-letter ASCII, its stopwords only)", () => {
    expect(orderedTerms("UI and PRD 一般")).toEqual(["prd", "一般"]);
  });

  it("know follow-up openings, changes of topic, report-backs and pointers back", () => {
    expect(["那如果是 B 呢?", "如果是 algorithm 呢?", "  What about B?", "要怎麼監控膨脹?"].every(startsAsFollowUp)).toBe(true);
    expect(["firebase是什麼?", "為什麼?", "另外想問"].some(startsAsFollowUp)).toBe(false);
    expect(["另外，即時通知要用 SSE?", "那我想問 Docker 的 volume?", "對了，VACUUM 要手動跑嗎?", "By the way, what about X?"].every(startsAsShift)).toBe(true);
    expect(startsAsShift("那如果一定要用 requests 呢?")).toBe(false);
    expect(["確實是 Seq Scan。", "p95 降到 120ms 了。", "找到了，卡在 orders 表的外鍵檢查。", "It works now."].every(isReportBack)).toBe(true);
    expect(["幫我寫一個 Docker compose 範例。", "dead tuples 很少嗎?", "Redis 快取", "Why is the sky blue", "Redis 的持久化是什麼", "Redis 持久化 RDB 與 AOF 差在哪", "一句超過三十個字的敘述一句超過三十個字的敘述一句超過三十個字的敘述。"].some(isReportBack)).toBe(false);
    expect(["寫好了，但跑不起來。", "Created the table, works now."].every(isReportBack)).toBe(true);
    expect(["pg_hba.conf 也得改嗎?", "索引建好了，再壓一次要用什麼參數?", "幫我總結這次壓測。"].every(hasReferent)).toBe(true);
    expect(hasReferent("我也許會改用 Redis 來做快取，因為它們的持久化策略比較適合這個大型專案的需求")).toBe(true); // 它們 points back
    expect(hasReferent("我也許會改用 Redis 來做快取，因為那些持久化策略比較適合這類大型專案的需求")).toBe(false);
    expect(continuesTopic("另外，它要怎麼設定?")).toBe(false);
  });
});

describe("splitting by topic", () => {
  it("groups replies with the question before them (replies before the first question open the first round)", () => {
    const turns = groupTurns([{ externalId: "x", role: "assistant", content: "hello", versions: 1 }, ...roundsOf(["q"])]);
    expect(turns.map((turn) => turn.messages.length)).toEqual([1, 2]);
  });

  it("cuts a combined list where a question shares no word with the conversation or the round before", () => {
    const messages = roundsOf(["Docker 容器怎麼裝?", "Docker 映像檔多大?", "Redis 快取要設多久?", "那 TTL 呢?", "Rust 所有權是什麼?"]);
    expect(splitByTopicShifts(messages, "combined").map((group) => group.length)).toEqual([4, 4, 2]);
  });

  it("keeps a question that shares a word with the reply before it", () => {
    const messages = roundsOf(["Docker 容器怎麼裝?", "Compose 檔怎麼寫?"], (n) => (n === 0 ? "安裝 Docker 之後可以用 Compose 管理多個容器。" : "寫 services。"));
    expect(splitByTopicShifts(messages, "combined")).toHaveLength(1);
  });

  it("never cuts before an answered round, nor on a question without topic words", () => {
    const unanswered: ParsedMessage[] = [
      { externalId: "q0", role: "user", content: "Docker 容器怎麼裝?", versions: 1 },
      { externalId: "q1", role: "user", content: "Redis 快取要設多久?", versions: 1 },
    ];
    expect(splitByTopicShifts(unanswered, "combined")).toHaveLength(1);
    expect(splitByTopicShifts(roundsOf(["Docker 容器怎麼裝?", "為什麼?", "好的謝謝"]), "combined")).toHaveLength(1);
  });

  it("in a long undated list, cuts only after 20 messages", () => {
    const early = roundsOf(["Docker 容器怎麼裝?", "Redis 快取要設多久?"]);
    expect(splitByTopicShifts(early, "long")).toHaveLength(1);
    const questions = [...Array.from({ length: TOPIC_LONG_MIN_MESSAGES / 2 }, (_, n) => `Docker 第 ${n} 題`), "Redis 快取要設多久?"];
    expect(splitByTopicShifts(roundsOf(questions), "long").map((group) => group.length)).toEqual([TOPIC_LONG_MIN_MESSAGES, 2]);
  });

  it("cuts over 500 messages between rounds", () => {
    const messages = roundsOf(Array.from({ length: 300 }, (_, n) => `Docker ${n}`));
    const chunks = splitOverLimit(messages);
    expect(chunks.map((chunk) => chunk.length)).toEqual([IMPORT_MAX_BRANCH_MESSAGES, 600 - IMPORT_MAX_BRANCH_MESSAGES]);
    expect(chunks[1]![0]!.role).toBe("user");
    const odd = [{ externalId: "x", role: "user" as const, content: "q", versions: 1 }, ...messages];
    expect(splitOverLimit(odd).every((chunk) => chunk[0]!.role === "user" && chunk.length <= IMPORT_MAX_BRANCH_MESSAGES)).toBe(true);
  });
});

describe("combined exports (B21)", () => {
  it("cuts the user's Gemini-Combined file into three conversations by topic, in file order", () => {
    // Act
    const parsed = parse(geminiCombinedSample(), "Gemini-Combined_雜談-2026-11-03.json");
    const conversations = byTime(parsed.conversations);
    // Assert
    expect(parsed.source).toBe("gemini");
    expect(conversations.map((conversation) => [conversation.title, conversation.messages.length])).toEqual([
      ["如果電腦平常都不關, CPU散熱多久換一次比較好?", 2],
      ["firebase是什麼?", 2],
      ["PRD一般是對內還對外的?", 4],
    ]);
    expect(conversations[2]!.messages[2]!.content).toBe("如果有UI的話PRD可以畫出來並加入互動功能, 但如果是algorithm呢?");
    expect(conversations.map((conversation) => conversation.folder)).toEqual(["雜談", "雜談", "雜談"]);
    expect(conversations.map((conversation) => conversation.createdAt)).toEqual(["2026-11-03T00:00:00.000Z", "2026-11-03T00:01:00.000Z", "2026-11-03T00:02:00.000Z"]);
    expect(conversations.map((conversation) => conversation.updatedAt)).toEqual(conversations.map((conversation) => conversation.createdAt));
    expect(new Set(conversations.map((conversation) => conversation.id)).size).toBe(3);
  });

  it("takes a file named Combined for a combined export without exportType", () => {
    const { exportType: _, ...plain } = geminiCombinedSample();
    expect(parse(plain, "Gemini-Combined_雜談.json").conversations).toHaveLength(3);
    expect(parse(plain, "雜談.json").conversations).toHaveLength(1);
    // A name alone does not cut a conversation whose messages carry their own times.
    const dated = { ...plain, dialogue: plain.dialogue.map((entry, n) => ({ ...entry, createdAt: new Date(Date.UTC(2026, 10, 3, 9, n)).toISOString() })) };
    expect(parse(dated, "combined-notes.json").conversations).toHaveLength(1);
  });

  it("cuts a 750-message combined file into its 25 topics", () => {
    const conversations = byTime(parse(longCombinedExport(), "Gemini-Combined_雜談-2026-11-03.json").conversations);
    expect(conversations).toHaveLength(25);
    expect(conversations.every((conversation) => conversation.messages.length === 30)).toBe(true);
    expect(conversations[0]!.title).toBe("Docker 容器是什麼?");
    expect(conversations.at(-1)!.createdAt).toBe("2026-11-03T00:24:00.000Z");
  });

  it("cuts a long undated list that is not combined only past 500 messages, by topic after 20", () => {
    const short = { title: "Notes", messages: roundsOf(Array.from({ length: 200 }, (_, n) => (n % 2 === 0 ? `Docker ${n}` : `Redis ${n}`))) };
    expect(parse(short).conversations).toHaveLength(1);
    const topics = ["Docker", "Redis", "Rust"].flatMap((name) => Array.from({ length: 100 }, (_, n) => `${name} 第 ${n} 題`));
    const long = parse({ title: "Notes", messages: roundsOf(topics, () => "ok") });
    expect(byTime(long.conversations).map((conversation) => [conversation.title, conversation.messages.length])).toEqual([
      ["Docker 第 0 題", 200],
      ["Redis 第 0 題", 200],
      ["Rust 第 0 題", 200],
    ]);
  });

  it("still cuts a long topic at 500 messages", () => {
    const one = parse({ title: "Notes", messages: roundsOf(Array.from({ length: 300 }, (_, n) => `Docker ${n}`)) });
    expect(byTime(one.conversations).map((conversation) => [conversation.title, conversation.messages.length])).toEqual([
      ["Docker 0", IMPORT_MAX_BRANCH_MESSAGES],
      [`Docker ${IMPORT_MAX_BRANCH_MESSAGES / 2}`, 600 - IMPORT_MAX_BRANCH_MESSAGES],
    ]);
  });
});

describe("threading by topic (B22)", () => {
  const interleaved = () => roundsOf(INTERLEAVED_ROUNDS.map(([question]) => question), (n) => INTERLEAVED_ROUNDS[n]![1]);

  it("threads A1 → B1 → A2 → C1 → A3 → B2 into three topics instead of six pieces", () => {
    // Arrange
    const messages = interleaved();
    // Act
    const topics = threadByTopicShifts(messages, "combined");
    // Assert
    expect(splitByTopicShifts(messages, "combined")).toHaveLength(6);
    expect(topics.map((topic) => topic.rounds)).toEqual([[1, 3, 5], [2, 6], [4]]);
    expect(topics[0]!.messages.map((message) => message.externalId)).toEqual(["q0", "a0", "q2", "a2", "q4", "a4"]);
  });

  it("keeps the B21 cuts when no topic comes back", () => {
    const messages = roundsOf(["Docker 容器怎麼裝?", "Docker 映像檔多大?", "Redis 快取要設多久?", "那 TTL 呢?", "Rust 所有權是什麼?"]);
    expect(threadByTopicShifts(messages, "combined").map((topic) => topic.messages.length)).toEqual(splitByTopicShifts(messages, "combined").map((group) => group.length));
  });

  it("joins the most recent of two earlier topics on a tie, and never leaves a short topic in long mode", () => {
    const units = ["Docker 容器", "Redis 快取", "Kafka 佇列", "Docker 與 Redis 一起用?"].map((question) => ({ title: "", question, reply: "ok", messages: 2 }));
    expect(threadUnits(units)).toEqual([[0], [1, 3], [2]]);
    expect(threadUnits(units, { minMessages: TOPIC_LONG_MIN_MESSAGES })).toEqual([[0, 1, 2, 3]]);
  });

  it("weighs words: a common one half, a name more than a Han pair, a title word half", () => {
    const units = [
      ["Nginx 的反向代理設定要怎麼寫?", "在 server 區塊加 location 與 proxy_pass 設定。"],
      ["Rust 的所有權設定是什麼?", "所有權是編譯期的記憶體設定規則。"],
      ["Nginx 設定的 proxy_pass 要加斜線嗎?", "看路徑要不要被取代。"],
      ["Rust 借用的設定錯誤怎麼修?", "縮短借用的範圍。"],
    ].map(([question, reply]) => ({ title: "", question: question!, reply: reply!, messages: 2 }));
    const weights = termWeights("Nginx 與 Rust 雜談", units);
    expect([weights.get("設定"), weights.get("nginx"), weights.get("反向"), weights.get("proxy_pass")]).toEqual([0.5, 0.75, 1, 1.5]);
    expect(threadUnits(units)).toEqual([[0, 2], [1, 3]]);
    // Rust halved by the title (0.75) plus the common 設定 (0.5) still comes back to Rust.
    expect(threadUnits(units, { title: "Nginx 與 Rust 雜談" })).toEqual([[0, 2], [1, 3]]);
  });

  it("lets 另外 open a new topic, keeps a report-back and a 那 follow-up that nothing else claims, and sends 那我想問 elsewhere", () => {
    const units = [
      ["asyncio 裡面呼叫 requests 會卡住嗎?", "會，requests 是同步阻塞的，要改用 aiohttp 或 to_thread。"],
      ["那如果一定要用 requests 呢?", "用 asyncio.to_thread 丟到執行緒池。"],
      ["那我想問 Docker 的 volume 要怎麼掛?", "用 -v 或 compose 的 volumes。"],
      ["掛好了，但權限是 root。", "加 user 參數或 chown。"],
      ["另外，aiohttp 的 ClientSession 要共用嗎?", "共用一個，程式結束再關。"],
    ].map(([question, reply]) => ({ title: "", question: question!, reply: reply!, messages: 2 }));
    expect(threadUnits(units)).toEqual([[0, 1, 4], [2, 3]]);
  });

  it("does not glue a new topic asked without a question mark to the old one", () => {
    const units = [
      ["Docker 容器是什麼?", "Docker 把應用程式包成容器。"],
      ["Why is the sky blue", "Rayleigh scattering."],
      ["Redis 持久化 RDB 與 AOF 差在哪", "RDB 是快照，AOF 是日誌。"],
    ].map(([question, reply]) => ({ title: "", question: question!, reply: reply!, messages: 2 }));
    expect(threadUnits(units)).toEqual([[0], [1], [2]]);
  });

  it("parses a combined export into the threaded topics, recording their rounds", () => {
    const conversations = byTime(parse(interleavedCombinedExport(), "Gemini-Combined_雜談-2026-11-03.json").conversations);
    expect(conversations.map((conversation) => [conversation.title, conversation.messages.length, conversation.threadedRounds])).toEqual([
      [INTERLEAVED_ROUNDS[0]![0], 6, [1, 3, 5]],
      [INTERLEAVED_ROUNDS[1]![0], 4, [2, 6]],
      [INTERLEAVED_ROUNDS[3]![0], 2, undefined],
    ]);
  });
});
