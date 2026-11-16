// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hasOwnTime, parseImport, type ParsedImport } from "./import-parsers";
import { loneStamp, parseTranscript } from "./import-transcript";

const parse = (text: string, options: Parameters<typeof parseImport>[1] = {}): ParsedImport => {
  const result = parseImport(text, options);
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.value;
};
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

describe("ChatGPT keeps each message's create_time (F14)", () => {
  const node = (id: string, parent: string | null, children: string[], role?: string, text?: string, at?: number) => ({
    id,
    parent,
    children,
    message: role ? { id, author: { role }, recipient: "all", content: { content_type: "text", parts: [text] }, metadata: {}, ...(at ? { create_time: at } : {}) } : null,
  });
  const conversation = {
    title: "PG 連線池設定",
    create_time: 1_786_544_400,
    update_time: 1_786_557_720,
    current_node: "a2",
    conversation_id: "c-pg",
    mapping: Object.fromEntries(
      [
        node("root", null, ["u1"]),
        node("u1", "root", ["a1old", "a1"], "user", "PgBouncer 要用哪種 pool mode？", 1_786_544_400),
        node("a1old", "u1", [], "assistant", "舊的回答。", 1_786_544_460),
        node("a1", "u1", ["u2"], "assistant", "transaction mode。", 1_786_544_520),
        node("u2", "a1", ["a2"], "user", "max_connections 呢？"),
        node("a2", "u2", [], "assistant", "留 100。", 1_786_557_720),
      ].map((item) => [item.id, item]),
    ),
  };

  it("dates the main line and the restored version from create_time; a message without one has none", () => {
    // Act
    const [parsed] = parse(JSON.stringify([conversation]), { fileName: "conversations.json" }).conversations;
    // Assert
    expect(parsed!.messages.map((message) => message.createdAt)).toEqual([new Date(1_786_544_400_000).toISOString(), new Date(1_786_544_520_000).toISOString(), undefined, new Date(1_786_557_720_000).toISOString()]);
    expect(parsed!.branches[0]!.messages[0]!.createdAt).toBe(new Date(1_786_544_460_000).toISOString());
    expect(parsed!.timeSource).toBe("exact");
    expect(parsed!.fileTime).toBeNull();
  });
});

describe("Claude keeps each message's created_at (F14)", () => {
  it("reads created_at onto the message", () => {
    // Arrange
    const conversation = {
      uuid: "c1",
      name: "transaction mode 的限制",
      created_at: "2026-08-12T07:10:00Z",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "哪些功能不能用？", created_at: "2026-08-12T07:10:00Z" },
        { uuid: "m2", sender: "assistant", text: "session 層級的 SET。", created_at: "2026-08-12T07:22:00+00:00" },
      ],
    };
    // Act
    const [parsed] = parse(JSON.stringify([conversation])).conversations;
    // Assert
    expect(parsed!.messages.map((message) => message.createdAt)).toEqual(["2026-08-12T07:10:00.000Z", "2026-08-12T07:22:00.000Z"]);
  });
});

describe("Gemini Takeout carries the turn's time to both messages (F14)", () => {
  it("dates the prompt and the reply of a turn", () => {
    const entry = { header: "Gemini Apps", title: "Prompted 壓測結果", time: "2026-08-15T02:05:00Z", products: ["Gemini Apps"], safeHtmlItem: [{ html: "<p>TPS 1840</p>" }] };
    const [parsed] = parse(JSON.stringify([entry]), { fileName: "MyActivity.json" }).conversations;
    expect(parsed!.messages.map((message) => [message.role, message.createdAt])).toEqual([
      ["user", "2026-08-15T02:05:00.000Z"],
      ["assistant", "2026-08-15T02:05:00.000Z"],
    ]);
  });
});

describe("a Tangent backup keeps every message's createdAt (F14)", () => {
  const message = (id: string, lineId: string, seq: number, role: string, content: string, createdAt: string) => ({ id, lineId, seq, role, content, kind: "chat", status: "done", meta: {}, createdAt });
  const backup = {
    rootLineId: "root",
    exportedAt: "2026-10-30T00:00:00Z",
    rootLine: { id: "root", title: "NAS", createdAt: "2026-08-01T00:00:00Z", lastActivityAt: "2026-08-02T00:00:00Z" },
    branches: [{ lineId: "b1", parentLineId: "root", rootLineId: "root", anchorMessageId: "m2", purpose: "RAID", kind: "investigate", status: "discarded", origin: "button" }],
    messagesByLine: {
      root: [message("m1", "root", 1, "user", "要買 NAS 嗎？", "2026-08-01T00:00:00Z"), message("m2", "root", 2, "assistant", "看需求。", "2026-08-01T00:01:00Z")],
      b1: [message("x1", "b1", 5, "user", "RAID 5 還是 10？", "2026-08-01T03:00:00Z")],
    },
  };

  it("on the main line and on its branches", () => {
    const [parsed] = parse(JSON.stringify(backup), { fileName: "tree.json" }).conversations;
    expect(parsed!.messages.map((item) => item.createdAt)).toEqual(["2026-08-01T00:00:00.000Z", "2026-08-01T00:01:00.000Z"]);
    expect(parsed!.branches[0]!.messages[0]!.createdAt).toBe("2026-08-01T03:00:00.000Z");
    expect(parsed!.createdAt).toBe("2026-08-01T00:00:00Z");
  });
});

describe("transcript timestamps (F14)", () => {
  it("reads a bracketed stamp before the label, one in brackets after it, and a lone stamp line above a label", () => {
    // Arrange
    const text = ["[2026-08-12 14:30] User: 第一問", "AI: 第一答", "", "## You (2026/08/12 15:05)", "第二問", "", "2026-08-12 15:06", "## ChatGPT", "第二答"].join("\n");
    // Act
    const result = parseTranscript(text)!;
    // Assert
    expect(result.conversation.messages.map((message) => [message.role, message.content, message.createdAt])).toEqual([
      ["user", "第一問", local(2026, 8, 12, 14, 30)],
      ["assistant", "第一答", undefined],
      ["user", "第二問", local(2026, 8, 12, 15, 5)],
      ["assistant", "第二答", local(2026, 8, 12, 15, 6)],
    ]);
    expect(result.conversation.createdAt).toBe(local(2026, 8, 12, 14, 30));
    expect(result.conversation.updatedAt).toBe(local(2026, 8, 12, 15, 6));
  });

  it("honours an explicit offset and leaves dates in the text alone", () => {
    const result = parseTranscript("User (2026-08-12T14:30Z): 計畫在 2026-09-01 10:00 上線嗎？\nAssistant: 對。")!;
    expect(result.conversation.messages[0]).toMatchObject({ role: "user", content: "計畫在 2026-09-01 10:00 上線嗎？", createdAt: "2026-08-12T14:30:00.000Z" });
    expect(result.conversation.messages[1]!.createdAt).toBeUndefined();
  });

  it("keeps a lone date line that is not followed by a label as text, and refuses impossible dates", () => {
    const result = parseTranscript("User: 看看\n2026-08-12 14:30\n這是內文\nAI: 好")!;
    expect(result.conversation.messages[0]!.content).toBe("看看\n2026-08-12 14:30\n這是內文");
    expect(loneStamp("2026-13-40 25:00")).toBeNull();
    expect(loneStamp("### **2026-08-12 14:30**")).toBe(local(2026, 8, 12, 14, 30));
  });

  it("has no dates when the transcript has none", () => {
    const result = parseTranscript("User: hi\nAI: hello")!;
    expect(result.conversation.createdAt).toBeNull();
    expect(hasOwnTime(result.conversation)).toBe(false);
  });
});

describe("the file's modification time as a fallback (F14 decision #4)", () => {
  it("uses fileModifiedAt for a conversation without any date of its own", () => {
    const [parsed] = parse("User: 壓測 -c 200\nAI: TPS 1840", { fileName: "壓測筆記.md", fileModifiedAt: "2026-08-18T09:00:00Z" }).conversations;
    expect(parsed!.timeSource).toBe("file");
    expect(parsed!.fileTime).toBe("2026-08-18T09:00:00.000Z");
  });

  it("prefers the transcript's own stamps over the file's time", () => {
    const [parsed] = parse("[2026-08-12 14:30] User: hi\nAI: hello", { fileName: "a.md", fileModifiedAt: "2026-08-18T09:00:00Z" }).conversations;
    expect(parsed!.timeSource).toBe("exact");
    expect(parsed!.fileTime).toBeNull();
  });

  it("has no time at all for pasted text without dates, and ignores a bad fileModifiedAt", () => {
    expect(parse("User: hi\nAI: hello").conversations[0]!.timeSource).toBe("none");
    expect(parse("User: hi\nAI: hello", { fileModifiedAt: "not a date" }).conversations[0]!.timeSource).toBe("none");
  });
});

describe("transcript stamps, review fixes", () => {
  it("refuses a day that does not exist, with or without an offset, and skips long lines quickly", () => {
    expect(loneStamp("2026-02-31 10:00")).toBeNull();
    expect(loneStamp("2026-02-31T10:00Z")).toBeNull();
    const long = `2026-08-12 14:30${" ".repeat(50_000)}x`;
    const started = performance.now();
    expect(loneStamp(long)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
