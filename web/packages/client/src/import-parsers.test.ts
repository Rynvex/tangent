// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { GEMINI_SESSION_GAP_MS, geminiConversations, parseImport, type ParsedImport } from "./import-parsers";
import { geminiCombinedSample } from "./import-combined-fixtures";
import { htmlToText } from "./import-html";
import type { ParsedConversation } from "./import-tree";

const parse = (text: string, fileName?: string): ParsedImport => {
  const result = parseImport(text, fileName ? { fileName } : {});
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.value;
};

/** Oldest first (the picker lists the newest first). */
const byTime = (list: readonly ParsedConversation[]) => [...list].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

/** A ChatGPT node: `message` null for the root. */
function node(id: string, parent: string | null, children: string[], message?: { role: string; text: string; hidden?: boolean; recipient?: string; type?: string }) {
  return {
    id,
    parent,
    children,
    message: message
      ? {
          id,
          author: { role: message.role },
          recipient: message.recipient ?? "all",
          content: { content_type: message.type ?? "text", parts: [message.text] },
          metadata: message.hidden ? { is_visually_hidden_from_conversation: true } : {},
        }
      : null,
  };
}

/** A conversation with a regenerated reply (a2) and an edited question (u3). */
function chatGptConversation(title = "Postgres MVCC 與索引設計", update = 1_761_800_000) {
  const mapping = Object.fromEntries(
    [
      node("root", null, ["sys"]),
      node("sys", "root", ["u1"], { role: "system", text: "", hidden: true }),
      node("u1", "sys", ["a1"], { role: "user", text: "幫我設計一個多租戶 SaaS 的事件表" }),
      node("a1", "u1", ["u2"], { role: "assistant", text: "先決定隔離方式。" }),
      node("u2", "a1", ["a2old", "a2"], { role: "user", text: "共用表。那 MVCC 有什麼影響？" }),
      node("a2old", "u2", [], { role: "assistant", text: "舊的回答。" }),
      node("a2", "u2", ["tool", "u3old", "u3"], { role: "assistant", text: "每次 UPDATE 都產生新版本。" }),
      node("tool", "a2", [], { role: "assistant", text: "print(1)", recipient: "python", type: "code" }),
      node("u3old", "a2", ["a3old"], { role: "user", text: "容器連不上？" }),
      node("a3old", "u3old", [], { role: "assistant", text: "看防火牆。" }),
      node("u3", "a2", ["a3"], { role: "user", text: "為什麼容器連不上宿主機 Postgres？" }),
      node("a3", "u3", [], { role: "assistant", text: "改用 host.docker.internal。" }),
    ].map((item) => [item.id, item]),
  );
  return { title, create_time: update - 100, update_time: update, mapping, current_node: "a3", conversation_id: `c-${update}` };
}

describe("ChatGPT conversations.json", () => {
  it("follows current_node up the mapping for the main line, skipping hidden and tool messages", () => {
    const parsed = parse(JSON.stringify([chatGptConversation()]), "conversations.json");
    expect(parsed.source).toBe("chatgpt");
    expect(parsed.branchesPossible).toBe(true);
    const [conversation] = parsed.conversations;
    expect(conversation!.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "幫我設計一個多租戶 SaaS 的事件表"],
      ["assistant", "先決定隔離方式。"],
      ["user", "共用表。那 MVCC 有什麼影響？"],
      ["assistant", "每次 UPDATE 都產生新版本。"],
      ["user", "為什麼容器連不上宿主機 Postgres？"],
      ["assistant", "改用 host.docker.internal。"],
    ]);
  });

  it("turns other versions into branches anchored on a main-line message and marks the versions", () => {
    const [conversation] = parse(JSON.stringify([chatGptConversation()])).conversations;
    expect(conversation!.branches).toEqual([
      { anchorExternalId: "u2", reason: "regenerate", messages: [{ role: "assistant", content: "舊的回答。" }] },
      {
        anchorExternalId: "a2",
        reason: "edit",
        messages: [
          { role: "user", content: "容器連不上？" },
          { role: "assistant", content: "看防火牆。" },
        ],
      },
    ]);
    expect(conversation!.messages.find((message) => message.externalId === "a2")!.versions).toBe(2);
    expect(conversation!.messages.find((message) => message.externalId === "u3")!.versions).toBe(2);
    expect(conversation!.messages.find((message) => message.externalId === "u1")!.versions).toBe(1);
  });

  it("counts an edited first question as skipped (nothing before it to hang on)", () => {
    const mapping = {
      root: node("root", null, ["q1old", "q1"]),
      q1old: node("q1old", "root", [], { role: "user", text: "first try" }),
      q1: node("q1", "root", ["r1"], { role: "user", text: "second try" }),
      r1: node("r1", "q1", [], { role: "assistant", text: "answer" }),
    };
    const [conversation] = parse(JSON.stringify([{ title: "t", mapping, current_node: "r1" }])).conversations;
    expect(conversation!.branches).toEqual([]);
    expect(conversation!.skippedBranches).toBe(1);
  });

  it("lists several conversations newest first and drops empty ones", () => {
    const empty = { title: "empty", mapping: { root: node("root", null, []) }, current_node: "root", update_time: 1_900_000_000 };
    const parsed = parse(JSON.stringify([chatGptConversation("older", 1_700_000_000), empty, chatGptConversation("newer", 1_800_000_000)]));
    expect(parsed.conversations.map((conversation) => conversation.title)).toEqual(["newer", "older"]);
  });

  it("reads the jsonData that chat.html embeds", () => {
    const html = `<!doctype html><html><body><div id="root"></div><script>var jsonData = ${JSON.stringify([chatGptConversation("from html")])};</script></body></html>`;
    const parsed = parse(html, "chat.html");
    expect(parsed.source).toBe("chatgpt");
    expect(parsed.conversations[0]!.title).toBe("from html");
  });
});

describe("Claude conversations.json", () => {
  it("reads text blocks in order (tool use and thinking left out)", () => {
    const conversation = {
      uuid: "c1",
      name: "Rust 學習順序",
      updated_at: "2026-10-01T00:00:00Z",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "先學什麼？", created_at: "2026-10-01T00:00:00Z" },
        {
          uuid: "m2",
          sender: "assistant",
          created_at: "2026-10-01T00:01:00Z",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "先學所有權。" },
            { type: "tool_use", name: "x" },
          ],
        },
      ],
    };
    const parsed = parse(JSON.stringify([conversation]));
    expect(parsed.source).toBe("claude");
    expect(parsed.conversations[0]!.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "先學什麼？"],
      ["assistant", "先學所有權。"],
    ]);
  });

  it("restores a retried reply from parent_message_uuid, the newest message ending the main line", () => {
    const root = "00000000-0000-4000-8000-000000000000";
    const conversation = {
      uuid: "c2",
      name: "",
      chat_messages: [
        { uuid: "q", sender: "human", text: "Question", parent_message_uuid: root, created_at: "2026-10-01T00:00:00Z" },
        { uuid: "r1", sender: "assistant", text: "First answer", parent_message_uuid: "q", created_at: "2026-10-01T00:01:00Z" },
        { uuid: "r2", sender: "assistant", text: "Second answer", parent_message_uuid: "q", created_at: "2026-10-01T00:02:00Z" },
      ],
    };
    const [parsed] = parse(JSON.stringify([conversation])).conversations;
    expect(parsed!.title).toBe("Question");
    expect(parsed!.messages.map((message) => message.content)).toEqual(["Question", "Second answer"]);
    // F14: the restored version keeps its own time too.
    expect(parsed!.branches).toEqual([{ anchorExternalId: "q", reason: "regenerate", messages: [{ role: "assistant", content: "First answer", createdAt: "2026-10-01T00:01:00.000Z" }] }]);
  });
});

describe("Gemini", () => {
  const entry = (prompt: string, answer: string, time: string) => ({ header: "Gemini Apps", title: `Prompted ${prompt}`, time, products: ["Gemini Apps"], safeHtmlItem: [{ html: `<p>${answer}</p>` }] });

  it("groups Takeout activity into conversations by 30-minute gaps, oldest turn first, without branches", () => {
    const list = [entry("third", "C", "2026-10-02T10:00:00Z"), entry("second", "B<b>!</b>", "2026-10-01T10:10:00Z"), entry("first", "A", "2026-10-01T10:00:00Z")];
    const parsed = parse(JSON.stringify(list), "MyActivity.json");
    expect(parsed.source).toBe("gemini");
    expect(parsed.branchesPossible).toBe(false);
    expect(parsed.conversations.map((conversation) => conversation.messages.map((message) => message.content))).toEqual([["third", "C"], ["first", "A", "second", "B!"]]);
  });

  it("reads Takeout's MyActivity.html into the same turns, never running its scripts", () => {
    const cell = (prompt: string, date: string, answer: string) =>
      `<div class="outer-cell"><div class="mdl-grid"><div class="header-cell"><p>Gemini Apps<br></p></div><div class="content-cell">Prompted ${prompt}<br>${date}<br><p>${answer}</p><ul><li>one</li></ul></div></div></div>`;
    const html = `<html><body><script>window.__ran = true</script>${cell("later", "Oct 2, 2026, 10:00:00 AM UTC", "Two")}${cell("earlier", "Oct 1, 2026, 10:00:00 AM UTC", "One")}</body></html>`;
    const parsed = parse(html, "MyActivity.html");
    expect((window as { __ran?: boolean }).__ran).toBeUndefined();
    expect(parsed.source).toBe("gemini");
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations.at(-1)!.messages.map((message) => message.content)).toEqual(["earlier", "One\n\n- one"]);
  });

  it("reads the API's contents (user / model)", () => {
    const parsed = parse(JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hi" }] }, { role: "model", parts: [{ text: "Hello" }] }] }));
    expect(parsed.source).toBe("gemini");
    expect(parsed.conversations[0]!.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("keeps everything in one conversation when the times are unknown", () => {
    const turns = [{ prompt: "a", response: "b", time: null }, { prompt: "c", response: "", time: null }];
    expect(geminiConversations(turns)).toHaveLength(1);
    expect(geminiConversations(turns)[0]!.messages).toHaveLength(3);
    expect(GEMINI_SESSION_GAP_MS).toBe(1_800_000);
  });

  it("reads a Gemini Markdown transcript as Gemini", () => {
    const parsed = parse("## You\nWhat is MVCC?\n\n## Gemini\nMulti-version concurrency control.");
    expect(parsed.source).toBe("gemini");
    expect(parsed.conversations[0]!.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "What is MVCC?"],
      ["assistant", "Multi-version concurrency control."],
    ]);
  });

  it("automatically analyzes Gemini-Combined browser extension JSON and strips DOM screen-reader prefixes", () => {
    const parsed = parse(JSON.stringify(geminiCombinedSample()), "Gemini-Combined_雜談-2026-11-03.json");
    expect(parsed.source).toBe("gemini");
    const [cpu] = byTime(parsed.conversations);
    expect(cpu!.folder).toBe("雜談");
    expect(cpu!.createdAt).toBe("2026-11-03T00:00:00.000Z");
    expect(cpu!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "如果電腦平常都不關, CPU散熱多久換一次比較好?"],
      ["assistant", geminiCombinedSample().dialogue[1]!.content.replace(/^Gemini 說了/, "").replace(/(?:\r?\n\s*)+編輯影像\s*$/, "").trim()],
    ]);
  });
  it("automatically analyzes arbitrary conversation JSON structures, pair turns, and trailing commas", () => {
    const customJson = `{
      "data": {
        "sessions": [
          {
            "id": "s1",
            "topic": "資料庫設計",
            "turns": [
              { "question": "MVCC 是什麼？", "answer": "多版本併發控制。" },
            ],
          },
        ],
      },
    }`;
    const parsed = parse(customJson, "export.json");
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]!.title).toBe("資料庫設計");
    expect(parsed.conversations[0]!.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "MVCC 是什麼？"],
      ["assistant", "多版本併發控制。"],
    ]);
  });
});

describe("Tangent backup", () => {
  const message = (id: string, lineId: string, seq: number, role: string, content: string, kind = "chat") => ({ id, lineId, seq, role, content, kind, status: "done", meta: {}, createdAt: "" });
  const backup = {
    rootLineId: "root",
    exportedAt: "2026-10-30T00:00:00Z",
    rootLine: { id: "root", title: "NAS 備份", folder: "家裡", tags: ["nas"], lastActivityAt: "2026-10-29T00:00:00Z" },
    branches: [
      { lineId: "b1", parentLineId: "root", rootLineId: "root", anchorMessageId: "m2", purpose: "比較 RAID", kind: "investigate", status: "open", origin: "button" },
      { lineId: "b2", parentLineId: "b1", rootLineId: "root", anchorMessageId: "x1", purpose: "deeper", kind: "investigate", status: "open", origin: "button" },
      { lineId: "b3", parentLineId: "root", rootLineId: "root", anchorMessageId: "m2", purpose: "aside", kind: "aside", status: "merged", origin: "selection" },
    ],
    messagesByLine: {
      root: [message("m1", "root", 1, "user", "要買 NAS 嗎？"), message("m2", "root", 2, "assistant", "看需求。"), message("card", "root", 9, "system", "card", "branch_card")],
      b1: [message("x1", "b1", 5, "user", "RAID 5 還是 10？"), message("x2", "b1", 6, "assistant", "10。")],
      b2: [message("y1", "b2", 7, "user", "deeper")],
    },
  };

  it("imports the main line and its first-level branches with their purpose, kind and status", () => {
    const parsed = parse(JSON.stringify(backup), "tree.json");
    expect(parsed.source).toBe("tangent");
    const [conversation] = parsed.conversations;
    expect(conversation!.title).toBe("NAS 備份");
    expect(conversation!.folder).toBe("家裡");
    expect(conversation!.tags).toEqual(["nas"]);
    expect(conversation!.messages.map((item) => item.externalId)).toEqual(["m1", "m2"]);
    expect(conversation!.branches).toEqual([
      {
        anchorExternalId: "m2",
        reason: "branch",
        purpose: "比較 RAID",
        kind: "investigate",
        status: "open",
        messages: [
          { role: "user", content: "RAID 5 還是 10？" },
          { role: "assistant", content: "10。" },
        ],
      },
    ]);
    // The deeper branch cannot hang on the main line; the aside is not imported.
    expect(conversation!.skippedBranches).toBe(1);
  });
});

describe("transcripts", () => {
  it("splits on speaker labels in several styles, keeping code blocks whole", () => {
    const text = ["**User:** 第一個問題", "", "ChatGPT said:", "回答一", "```", "User: not a label inside code", "```", "你：第二個問題", "AI：回答二"].join("\n");
    const parsed = parse(text);
    expect(parsed.source).toBe("chatgpt");
    expect(parsed.conversations[0]!.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "第一個問題"],
      ["assistant", "回答一\n```\nUser: not a label inside code\n```"],
      ["user", "第二個問題"],
      ["assistant", "回答二"],
    ]);
    expect(parsed.guessedRoles).toBe(false);
  });

  it("alternates paragraphs when there is no label, and says the roles were guessed", () => {
    const parsed = parse("A question?\n\nAn answer.\n\nAnother question?");
    expect(parsed.source).toBe("text");
    expect(parsed.guessedRoles).toBe(true);
    expect(parsed.conversations[0]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it("keeps a long first line after its label whole, and reads a huge line without a label quickly", () => {
    const long = "x".repeat(500);
    expect(parse(`User: ${long}\nAI: ok`).conversations[0]!.messages[0]!.content).toBe(long);
    const started = Date.now();
    parse(`${" ".repeat(200_000)}a\nUser: hi`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not let one bad timestamp make a ChatGPT export unreadable", () => {
    const mapping = { r: node("r", null, ["q"]), q: node("q", "r", [], { role: "user", text: "hi" }) };
    const parsed = parse(JSON.stringify([{ title: "t", mapping, current_node: "q", update_time: 1e20 }]));
    expect(parsed.conversations[0]!.updatedAt).toBeNull();
  });

  it("does not take ordinary words for labels", () => {
    const parsed = parse("User: hi\nusername: bob\nYou can try again.\nAssistant: ok");
    expect(parsed.conversations[0]!.messages.map((message) => message.content)).toEqual(["hi\nusername: bob\nYou can try again.", "ok"]);
  });
});

describe("refusals", () => {
  it("names empty input, unknown JSON and files without messages", () => {
    expect(parseImport("   ")).toEqual({ ok: false, error: "empty" });
    expect(parseImport(JSON.stringify({ hello: "world" }))).toEqual({ ok: false, error: "unsupported" });
    expect(parseImport("{not json", { fileName: "x.json" })).toEqual({ ok: false, error: "unsupported" });
    expect(parseImport(JSON.stringify([{ title: "t", mapping: {} }]))).toEqual({ ok: false, error: "noMessages" });
  });
});

describe("htmlToText", () => {
  it("keeps blocks, list items and code apart", () => {
    const doc = new DOMParser().parseFromString("<div><h2>Title</h2><p>One <b>two</b></p><pre>a\nb</pre><ul><li>x</li></ul><style>p{}</style></div>", "text/html");
    expect(htmlToText(doc.body)).toBe("## Title\n\nOne two\n\n```\na\nb\n```\n\n- x");
  });
});
