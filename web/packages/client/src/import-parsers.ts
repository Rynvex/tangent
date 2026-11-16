/**
 * Reads an export someone brings in (F13 S2): ChatGPT's conversations.json
 * (and chat.html), Claude's conversations.json, Gemini (Takeout activity as
 * JSON or HTML, the API's `contents`, or a Markdown transcript), a Tangent
 * backup (`GET /lines/{id}/export`, as the export dialog saves it) and plain
 * text or Markdown transcripts. Every file is untrusted: unknown structures
 * are skipped, never guessed into messages, and a file with nothing usable
 * is a clear error. Pure, apart from the injected HTML parser.
 */
import { IMPORT_MAX_BRANCH_MESSAGES, type ImportRole } from "./b18-routes";
import { normalizeTreeExport } from "./b14-routes";
import { chatGptJsonFromHtml, defaultParseHtml, htmlToText, parseGeminiActivityHtml, type GeminiTurn, type ParseHtml } from "./import-html";
import { splitOverLimit, threadByTopicShifts, type TopicSplitMode } from "./import-topics";
import { parseTranscript } from "./import-transcript";
import { conversationFromTree, type ImportSourceKind, type ParsedBranch, type ParsedBranchMessage, type ParsedConversation, type ParsedMessage, type TreeNode } from "./import-tree";
import { isObject, obj, str } from "./wire";

export type { ImportSourceKind, ImportTimeSource, ParsedBranch, ParsedBranchMessage, ParsedConversation, ParsedMessage } from "./import-tree";

export interface ParsedImport {
  source: ImportSourceKind;
  /** Newest first (the picker's default is the first). */
  conversations: ParsedConversation[];
  /** The source can have restorable versions (not Gemini, not transcripts). */
  branchesPossible: boolean;
  /** A transcript without speaker labels: roles alternate and may be wrong. */
  guessedRoles: boolean;
}

export type ImportParseError = "empty" | "unsupported" | "noMessages";

export type ImportParseResult = { ok: true; value: ParsedImport } | { ok: false; error: ImportParseError };

/** Gemini activity turns more than this far apart start another conversation (Takeout has no conversation ids). */
export const GEMINI_SESSION_GAP_MS = 30 * 60_000;
const TITLE_RUNES = 60;

const fail = (error: ImportParseError): ImportParseResult => ({ ok: false, error });
const USER_ROLES = new Set(["user", "human", "client", "customer", "person", "you", "me", "prompt", "question", "query", "提问", "提問", "使用者", "你"]);
const ASSISTANT_ROLES = new Set(["assistant", "model", "ai", "bot", "chatbot", "gemini", "bard", "claude", "chatgpt", "gpt", "openai", "anthropic", "answer", "response", "reply"]);

const role = (raw: unknown): ImportRole | null => {
  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase();
    if (USER_ROLES.has(key)) return "user";
    if (ASSISTANT_ROLES.has(key)) return "assistant";
    if (/^(user|human)\b/.test(key) || /-(user|human)$/.test(key)) return "user";
    if (/^(assistant|model|ai|bot|gemini|claude|chatgpt|gpt)\b/.test(key) || /-(assistant|model|ai|bot)$/.test(key)) return "assistant";
  }
  if (isObject(raw)) return role(raw.role ?? raw.name ?? raw.type ?? raw.sender ?? raw.author);
  return null;
};

/** Deduplicates `X  X` when a web scraper captured both the screen-reader label and the visible text of a prompt. */
function deduplicateRepeatedPrompt(text: string): string {
  const trimmed = text.trim();
  const half = Math.floor(trimmed.length / 2);
  for (let split = half - 2; split <= half + 2; split += 1) {
    if (split <= 0 || split >= trimmed.length) continue;
    const left = trimmed.slice(0, split).trim();
    const right = trimmed.slice(split).trim();
    if (left.length >= 2 && left === right) return left;
  }
  return trimmed;
}

/** Strips DOM screen-reader prefixes ("你說了 …", "Gemini 說了…") and trailing UI button labels from scraped exports. */
function cleanScrapedText(raw: string, who: ImportRole): string {
  const trimmed = raw.trim();
  if (who === "user") {
    const stripped = trimmed.replace(/^(?:你說了|你说|You said)\s*[:：]?\s*/i, "");
    return stripped !== trimmed ? deduplicateRepeatedPrompt(stripped) : deduplicateRepeatedPrompt(trimmed);
  }
  return trimmed
    .replace(/^(?:Gemini\s*說了|Gemini\s*说|Gemini said|ChatGPT\s*說了|ChatGPT said|Claude\s*說了|Claude said)\s*[:：]?\s*/i, "")
    .replace(/(?:\r?\n\s*)+(?:編輯影像|Edit image)\s*$/i, "")
    .trim();
}
const titleOf = (messages: readonly ParsedMessage[]) => {
  const first = (messages.find((message) => message.role === "user") ?? messages[0])?.content.replace(/\s+/g, " ").trim() ?? "";
  return Array.from(first).length <= TITLE_RUNES ? first : `${Array.from(first).slice(0, TITLE_RUNES - 1).join("")}…`;
};
/** Seconds (ChatGPT) or an ISO string (Claude) as ISO; null otherwise. */
export const isoTime = (raw: unknown): string | null => {
  const at = typeof raw === "number" ? new Date(raw * 1000) : typeof raw === "string" ? new Date(Date.parse(raw)) : null;
  // A finite number far out of range is an Invalid Date too (toISOString would throw).
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
};
/** `{ createdAt }` when the source had a time, else nothing (messages without one stay as they were). */
const timed = (raw: unknown): { createdAt?: string } => {
  const at = isoTime(raw);
  return at ? { createdAt: at } : {};
};
const newestFirst = (list: ParsedConversation[]) => [...list].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
const usable = (conversation: ParsedConversation) => conversation.messages.length > 0;

function result(source: ImportSourceKind, conversations: ParsedConversation[], branchesPossible: boolean, guessedRoles = false): ImportParseResult {
  const kept = newestFirst(conversations.filter(usable));
  return kept.length === 0 ? fail("noMessages") : { ok: true, value: { source, conversations: kept, branchesPossible, guessedRoles } };
}

// ChatGPT -----------------------------------------------------------------------

/** The visible text of a ChatGPT message; null for tool calls, hidden context and non-text content. */
function chatGptMessage(raw: unknown): ParsedBranchMessage | null {
  const message = obj(raw);
  const who = role(obj(message.author).role);
  if (!who) return null;
  const metadata = obj(message.metadata);
  if (metadata.is_visually_hidden_from_conversation === true) return null;
  if (typeof message.recipient === "string" && message.recipient !== "all") return null;
  const content = obj(message.content);
  if (content.content_type !== "text" && content.content_type !== "multimodal_text") return null;
  const parts = Array.isArray(content.parts) ? content.parts.filter((part): part is string => typeof part === "string") : [];
  const text = parts.join("\n").trim();
  return text ? { role: who, content: text, ...timed(message.create_time) } : null;
}

function chatGptConversation(raw: unknown, index: number): ParsedConversation | null {
  const conversation = obj(raw);
  if (!isObject(conversation.mapping)) return null;
  const nodes = new Map<string, TreeNode>();
  for (const [id, value] of Object.entries(conversation.mapping)) {
    const node = obj(value);
    nodes.set(id, {
      id,
      parent: typeof node.parent === "string" ? node.parent : null,
      children: Array.isArray(node.children) ? node.children.filter((child): child is string => typeof child === "string") : [],
      message: chatGptMessage(node.message),
    });
  }
  const leaves = [...nodes.values()].filter((node) => node.children.length === 0);
  const current = typeof conversation.current_node === "string" && nodes.has(conversation.current_node) ? conversation.current_node : leaves.at(-1)?.id;
  if (!current) return null;
  const tree = conversationFromTree(nodes, current);
  return {
    id: str(conversation.conversation_id) || str(conversation.id) || String(index),
    title: str(conversation.title).trim() || titleOf(tree.messages),
    createdAt: isoTime(conversation.create_time),
    updatedAt: isoTime(conversation.update_time) ?? isoTime(conversation.create_time),
    messages: tree.messages,
    branches: tree.branches,
    skippedBranches: tree.skipped,
  };
}

const looksChatGpt = (item: unknown) => isObject(item) && isObject(item.mapping);

// Claude ------------------------------------------------------------------------

/** Claude's text blocks (tool use, results and thinking left out), or its plain `text`. */
function claudeText(message: Record<string, unknown>): string {
  if (Array.isArray(message.content)) {
    const blocks = message.content.map(obj).filter((block) => block.type === "text" && typeof block.text === "string");
    if (blocks.length > 0) return blocks.map((block) => str(block.text)).join("\n\n").trim();
  }
  return str(message.text).trim();
}

function claudeConversation(raw: unknown, index: number): ParsedConversation | null {
  const conversation = obj(raw);
  if (!Array.isArray(conversation.chat_messages)) return null;
  const items = conversation.chat_messages.map(obj).filter((message) => typeof message.uuid === "string");
  const ids = new Set(items.map((message) => str(message.uuid)));
  const nodes = new Map<string, TreeNode>();
  const branched = items.some((message) => typeof message.parent_message_uuid === "string" && ids.has(str(message.parent_message_uuid)));
  let previous: string | null = null;
  for (const message of items) {
    const id = str(message.uuid);
    const who = role(message.sender);
    const text = claudeText(message);
    // Without parent ids the list is the conversation, in order.
    const parent = branched ? (ids.has(str(message.parent_message_uuid)) ? str(message.parent_message_uuid) : null) : previous;
    nodes.set(id, { id, parent, children: [], message: who && text ? { role: who, content: text, ...timed(message.created_at) } : null });
    previous = id;
  }
  for (const node of nodes.values()) if (node.parent) nodes.get(node.parent)?.children.push(node.id);
  // The newest message ends the main path (the export does not say which version was on screen).
  const newest = [...items].sort((a, b) => str(a.created_at).localeCompare(str(b.created_at))).at(-1);
  if (!newest) return null;
  const tree = conversationFromTree(nodes, str(newest.uuid));
  return {
    id: str(conversation.uuid) || String(index),
    title: str(conversation.name).trim() || titleOf(tree.messages),
    createdAt: isoTime(conversation.created_at),
    updatedAt: isoTime(conversation.updated_at) ?? isoTime(conversation.created_at),
    messages: tree.messages,
    branches: tree.branches,
    skippedBranches: tree.skipped,
  };
}

const looksClaude = (item: unknown) => isObject(item) && Array.isArray(item.chat_messages);

// Gemini ------------------------------------------------------------------------

/** Takeout activity turns grouped into conversations by gaps of 30 minutes or more (one group when times are unknown). */
export function geminiConversations(turns: readonly GeminiTurn[]): ParsedConversation[] {
  const groups: GeminiTurn[][] = [];
  for (const turn of turns) {
    const last = groups.at(-1)?.at(-1);
    const gap = last?.time && turn.time ? Date.parse(turn.time) - Date.parse(last.time) : 0;
    if (!last || gap >= GEMINI_SESSION_GAP_MS) groups.push([turn]);
    else groups.at(-1)!.push(turn);
  }
  return groups.map((group, index) => {
    const messages: ParsedMessage[] = group.flatMap((turn, n) => [
      { externalId: `g${index}-${n}-q`, role: "user" as const, content: turn.prompt, versions: 1, ...timed(turn.time) },
      ...(turn.response ? [{ externalId: `g${index}-${n}-a`, role: "assistant" as const, content: turn.response, versions: 1, ...timed(turn.time) }] : []),
    ]);
    return { id: `gemini-${index}`, title: titleOf(messages), createdAt: group[0]?.time ?? null, updatedAt: group.at(-1)?.time ?? null, messages, branches: [], skippedBranches: 0 };
  });
}

/** One Takeout JSON entry as a turn; null when it is not a Gemini prompt. */
function geminiActivityTurn(raw: unknown, parseHtml: ParseHtml): GeminiTurn | null {
  const entry = obj(raw);
  const header = `${str(entry.header)} ${Array.isArray(entry.products) ? entry.products.join(" ") : ""}`;
  const title = str(entry.title);
  if (!/gemini|bard/i.test(header) || !/^\s*(Prompted|Asked|已提示|已詢問|提示)/i.test(title)) return null;
  const prompt = title.replace(/^\s*(Prompted|Asked|已提示|已詢問|提示)\s*[:：]?\s*/i, "").trim();
  const html = Array.isArray(entry.safeHtmlItem) ? entry.safeHtmlItem.map((item) => str(obj(item).html)).join("\n") : "";
  const response = html ? htmlToText(parseHtml(`<body>${html}</body>`).body) : "";
  return prompt ? { prompt, response, time: isoTime(entry.time) } : null;
}

const looksGeminiActivity = (item: unknown) => isObject(item) && /gemini|bard/i.test(`${str(item.header)} ${Array.isArray(item.products) ? item.products.join(" ") : ""}`) && typeof item.title === "string";

/** The Gemini API's `contents` ([{role: "user" | "model", parts: [{text}]}]). */
function geminiContents(raw: unknown): ParsedConversation | null {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw).contents) ? (obj(raw).contents as unknown[]) : null;
  if (!list || !list.every((item) => isObject(item) && Array.isArray(item.parts) && (item.role === "user" || item.role === "model"))) return null;
  const messages: ParsedMessage[] = list.flatMap((item, index) => {
    const entry = obj(item);
    const content = (entry.parts as unknown[]).map((part) => str(obj(part).text)).join("\n").trim();
    const who = role(entry.role);
    return who && content ? [{ externalId: `c${index + 1}`, role: who, content, versions: 1 }] : [];
  });
  return { id: "gemini-contents", title: str(obj(raw).title) || titleOf(messages), createdAt: null, updatedAt: null, messages, branches: [], skippedBranches: 0 };
}

// Tangent -----------------------------------------------------------------------

const looksTangent = (raw: unknown) => isObject(raw) && typeof raw.rootLineId === "string" && isObject(raw.messagesByLine) && isObject(raw.rootLine);

/** A backup's main line and its first-level branches (asides and deeper branches are left out and counted). */
function tangentConversation(raw: unknown): ParsedConversation {
  const tree = normalizeTreeExport(raw);
  const chat = (lineId: string) =>
    (tree.messagesByLine[lineId] ?? [])
      .filter((message) => message.kind === "chat" && message.status === "done" && (message.role === "user" || message.role === "assistant"))
      .sort((a, b) => a.seq - b.seq);
  const main = chat(tree.rootLineId);
  const mainIds = new Set(main.map((message) => message.id));
  const branches: ParsedBranch[] = [];
  let skipped = 0;
  for (const branch of tree.branches) {
    if (branch.kind === "aside" || branch.origin === "previous_main_line") continue;
    const messages = chat(branch.lineId).map((message) => ({ role: message.role as ImportRole, content: message.content, ...timed(message.createdAt) }));
    if (branch.parentLineId !== tree.rootLineId || !mainIds.has(branch.anchorMessageId) || messages.length === 0) {
      skipped += 1;
      continue;
    }
    branches.push({ anchorExternalId: branch.anchorMessageId, reason: "branch", messages, purpose: branch.purpose, kind: branch.kind, status: branch.status === "open" ? "open" : "discarded" });
  }
  const versions = new Map<string, number>();
  for (const branch of branches) versions.set(branch.anchorExternalId, (versions.get(branch.anchorExternalId) ?? 1) + 1);
  return {
    id: tree.rootLineId,
    title: tree.rootLine.title,
    createdAt: tree.rootLine.createdAt || null,
    updatedAt: tree.rootLine.lastActivityAt || tree.exportedAt || null,
    messages: main.map((message) => ({ externalId: message.id, role: message.role as ImportRole, content: message.content, versions: 1, ...timed(message.createdAt) })),
    branches,
    skippedBranches: skipped,
    folder: tree.rootLine.folder,
    tags: tree.rootLine.tags,
  };
}

// Structural JSON analyzer -------------------------------------------------------

const MESSAGE_ARRAY_KEYS = ["dialogue", "messages", "chat_messages", "turns", "history", "contents", "conversation", "entries", "items", "log", "chat", "data"] as const;
const CONTAINER_ARRAY_KEYS = ["conversations", "chats", "sessions", "threads", "history", "items", "data", "results", "exports", "records"] as const;
const ROLE_KEYS = ["role", "sender", "author", "speaker", "from", "by", "actor", "participant", "source", "type", "id"] as const;
const CONTENT_KEYS = ["content", "text", "message", "body", "value", "markdown", "output", "response", "parts", "blocks", "segments", "chunks"] as const;
const PROMPT_KEYS = ["prompt", "question", "query", "input", "user", "human", "request"] as const;
const REPLY_KEYS = ["response", "answer", "reply", "output", "assistant", "model", "ai", "gemini", "completion"] as const;
const TITLE_KEYS = ["title", "name", "projectName", "topic", "subject", "summary", "label", "chatTitle", "conversationTitle"] as const;
const FOLDER_KEYS = ["folder", "projectName", "category", "project", "group", "workspace"] as const;
const CREATED_KEYS = ["createdAt", "created_at", "create_time", "timestamp", "time", "date", "startTime", "start_time", "exportedAt", "exported_at"] as const;
const UPDATED_KEYS = ["updatedAt", "updated_at", "update_time", "lastModified", "last_activity_at", "endTime", "end_time"] as const;

interface InheritedMeta {
  title?: string;
  folder?: string;
  tags?: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  combined?: boolean;
  /** B21: the file's name says combined (no `exportType`): only an undated list is cut as one. */
  combinedName?: boolean;
  sourceHint?: string;
}

function extractTextValue(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (isObject(item)) {
          if (typeof item.type === "string" && item.type !== "text" && item.type !== "output_text" && item.type !== "input_text" && !("text" in item) && !("content" in item)) return "";
          return extractTextValue(item.text ?? item.content ?? item.value ?? item.markdown ?? item.body);
        }
        return "";
      })
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }
  if (isObject(raw)) {
    if (Array.isArray(raw.parts)) return extractTextValue(raw.parts);
    return extractTextValue(raw.text ?? raw.content ?? raw.value ?? raw.markdown ?? raw.body);
  }
  return "";
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const val = str(record[key]).trim();
    if (val) return val;
  }
  return "";
}

function firstIsoTime(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const at = isoTime(record[key]);
    if (at) return at;
  }
  return null;
}

function extractGenericMessages(item: unknown, index: number): { messages: ParsedMessage[]; startsNewChat: boolean; rawHint: string } | null {
  if (!isObject(item)) return null;
  let who: ImportRole | null = null;
  for (const key of ROLE_KEYS) {
    who = role(item[key]);
    if (who) break;
  }
  const time = firstIsoTime(item, [...CREATED_KEYS, ...UPDATED_KEYS, "sentAt", "sent_at"]);
  const rawId = str(item.id) || str(item.uuid) || str(item.message_id) || str(item.messageId);
  const startsNewChat = index > 0 && /^(0|0-user|0-human)$/i.test(rawId.trim());
  if (who) {
    for (const key of CONTENT_KEYS) {
      if (!(key in item)) continue;
      const rawText = extractTextValue(item[key]);
      if (!rawText) continue;
      const content = cleanScrapedText(rawText, who);
      if (!content) continue;
      return {
        messages: [{ externalId: rawId || `m${index + 1}`, role: who, content, versions: 1, ...(time ? { createdAt: time } : {}) }],
        startsNewChat,
        rawHint: rawText.slice(0, 80),
      };
    }
  }
  // Pair-based turn object: `{ prompt, response }` / `{ question, answer }` / `{ user, assistant }`.
  const promptText = firstString(item, PROMPT_KEYS);
  const replyText = firstString(item, REPLY_KEYS);
  if (promptText && (replyText || "response" in item || "answer" in item || "reply" in item)) {
    const q = cleanScrapedText(promptText, "user");
    const a = replyText ? cleanScrapedText(replyText, "assistant") : "";
    const out: ParsedMessage[] = [];
    if (q) out.push({ externalId: `${rawId || `t${index + 1}`}-q`, role: "user", content: q, versions: 1, ...(time ? { createdAt: time } : {}) });
    if (a) out.push({ externalId: `${rawId || `t${index + 1}`}-a`, role: "assistant", content: a, versions: 1, ...(time ? { createdAt: time } : {}) });
    if (out.length > 0) return { messages: out, startsNewChat, rawHint: `${promptText.slice(0, 40)} ${replyText.slice(0, 40)}` };
  }
  return null;
}

function parseMessageList(list: readonly unknown[]): { groups: ParsedMessage[][]; hints: string[] } | null {
  if (list.length === 0) return null;
  const groups: ParsedMessage[][] = [[]];
  const hints: string[] = [];
  let matched = 0;
  for (let i = 0; i < list.length; i += 1) {
    const parsed = extractGenericMessages(list[i], i);
    if (!parsed) continue;
    matched += 1;
    if (parsed.rawHint) hints.push(parsed.rawHint);
    if (parsed.startsNewChat && groups.at(-1)!.length > 0) groups.push([]);
    groups.at(-1)!.push(...parsed.messages);
  }
  if (matched === 0 || matched < Math.ceil(list.length * 0.5)) return null;
  const nonEmpty = groups.filter((group) => group.length > 0);
  return nonEmpty.length > 0 ? { groups: nonEmpty, hints } : null;
}

function mergeMeta(parent: InheritedMeta, record: Record<string, unknown>): InheritedMeta {
  const title = firstString(record, TITLE_KEYS) || parent.title;
  const folder = firstString(record, FOLDER_KEYS) || parent.folder;
  const rawTags = Array.isArray(record.tags) ? record.tags : Array.isArray(record.labels) ? record.labels : null;
  const tags = rawTags ? rawTags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : parent.tags;
  const createdAt = firstIsoTime(record, CREATED_KEYS) ?? parent.createdAt ?? null;
  const updatedAt = firstIsoTime(record, UPDATED_KEYS) ?? createdAt ?? parent.updatedAt ?? null;
  const combined = parent.combined || str(record.exportType).toLowerCase() === "combined";
  const sourceHint = [parent.sourceHint, str(record.source), str(record.platform), str(record.provider), str(record.model), str(record.app), str(record.projectName)].filter(Boolean).join(" ");
  return {
    ...(title ? { title } : {}),
    ...(folder ? { folder } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    createdAt,
    updatedAt,
    combined,
    ...(parent.combinedName ? { combinedName: true } : {}),
    sourceHint,
  };
}

/**
 * B21: which topic splitting a message group gets: a combined export (`exportType`) always, one only named so when
 * its messages are undated, and any other undated list only when over one branch's limit.
 */
function topicMode(group: readonly ParsedMessage[], meta: InheritedMeta): TopicSplitMode | null {
  const undated = !group.some((message) => message.createdAt);
  if (meta.combined || (meta.combinedName && undated)) return "combined";
  if (group.length > IMPORT_MAX_BRANCH_MESSAGES && undated) return "long";
  return null;
}

/** One conversation cut from a message group, with the rounds of the group it threads together (B22) when they are not one run. */
interface SessionGroup {
  messages: ParsedMessage[];
  rounds?: number[];
}

/** Whether rounds skip some (a topic threaded across others: 1, 3, 5). */
const isThreaded = (rounds: readonly number[]) => rounds.some((round, index) => index > 0 && round !== rounds[index - 1]! + 1);

/**
 * A message group as the conversations it becomes: cut by topic (import-topics.ts; B22: a round returning to an earlier
 * topic joins it), then at 500 messages between rounds.
 */
function sessionGroups(group: readonly ParsedMessage[], meta: InheritedMeta): SessionGroup[] {
  const mode = topicMode(group, meta);
  if (!mode) return splitOverLimit(group).map((messages) => ({ messages }));
  return threadByTopicShifts(group, mode).flatMap((topic) => {
    const chunks = splitOverLimit(topic.messages);
    return chunks.length === 1 && isThreaded(topic.rounds) ? [{ messages: chunks[0]!, rounds: topic.rounds }] : chunks.map((messages) => ({ messages }));
  });
}

/** One conversation keeps the file's title; several are each named by their first question (else the file's title and their number). */
function genericTitle(messages: readonly ParsedMessage[], meta: InheritedMeta, baseId: string, index: number, count: number): string {
  if (count === 1) return meta.title || titleOf(messages) || baseId;
  return titleOf(messages) || `${meta.title || baseId} (${index + 1})`;
}

/** B21: the time between conversations cut from one undated file. */
const TOPIC_STEP_MS = 60_000;

/**
 * A conversation's dates: its messages' (else the file's). Several cut from a file with only one date and undated
 * messages are a minute apart in file order, so arranging them by time keeps that order.
 */
function genericTimes(messages: readonly ParsedMessage[], meta: InheritedMeta, index: number, stepped: boolean): { createdAt: string | null; updatedAt: string | null } {
  const base = stepped && meta.createdAt ? Date.parse(meta.createdAt) : Number.NaN;
  if (!Number.isNaN(base)) {
    const at = new Date(base + index * TOPIC_STEP_MS).toISOString();
    return { createdAt: at, updatedAt: at };
  }
  const firstTime = messages.find((m) => m.createdAt)?.createdAt ?? meta.createdAt ?? null;
  const lastTime = [...messages].reverse().find((m) => m.createdAt)?.createdAt ?? meta.updatedAt ?? firstTime;
  return { createdAt: firstTime, updatedAt: lastTime };
}

function buildGenericConversations(groups: ParsedMessage[][], meta: InheritedMeta, baseId: string): ParsedConversation[] {
  const splitGroups = groups.flatMap((group) => sessionGroups(group, meta));
  const stepped = splitGroups.length > 1 && !splitGroups.some((group) => group.messages.some((message) => message.createdAt));
  return splitGroups.map(({ messages: group, rounds }, g) => {
    const messages = group.map((msg, idx) => ({ ...msg, externalId: `m${idx + 1}-${msg.externalId}` }));
    return {
      id: splitGroups.length === 1 ? baseId : `${baseId}-${g + 1}`,
      title: genericTitle(messages, meta, baseId, g, splitGroups.length),
      ...genericTimes(messages, meta, g, stepped),
      messages,
      branches: [],
      skippedBranches: 0,
      ...(meta.folder ? { folder: meta.folder } : {}),
      ...(meta.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
      ...(rounds ? { threadedRounds: rounds } : {}),
    };
  });
}

function collectGenericConversations(node: unknown, meta: InheritedMeta, pathId: string, depth: number, hints: string[]): ParsedConversation[] {
  if (depth > 5 || !node) return [];
  if (Array.isArray(node)) {
    const asMessages = parseMessageList(node);
    if (asMessages) {
      hints.push(...asMessages.hints);
      return buildGenericConversations(asMessages.groups, meta, pathId || "conv-1");
    }
    return node.flatMap((item, index) => collectGenericConversations(item, meta, `${pathId || "conv"}-${index + 1}`, depth + 1, hints));
  }
  if (!isObject(node)) return [];
  const nextMeta = mergeMeta(meta, node);
  const ownId = str(node.id) || str(node.uuid) || str(node.conversation_id) || str(node.conversationId) || str(node.sessionId) || str(node.threadId) || pathId || "conv-1";
  // 1. Check known message-list keys on this object first, then any other array property whose items are messages.
  const checked = new Set<string>();
  for (const key of [...MESSAGE_ARRAY_KEYS, ...Object.keys(node)]) {
    if (checked.has(key)) continue;
    checked.add(key);
    const val = node[key];
    if (!Array.isArray(val)) continue;
    const asMessages = parseMessageList(val);
    if (asMessages) {
      hints.push(...asMessages.hints);
      return buildGenericConversations(asMessages.groups, nextMeta, ownId);
    }
  }
  // 2. Check container keys (`conversations`, `chats`, `sessions`, `data`, ...) or nested objects.
  const fromContainers: ParsedConversation[] = [];
  const visitedKeys = new Set<string>();
  for (const key of [...CONTAINER_ARRAY_KEYS, ...Object.keys(node)]) {
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);
    const val = node[key];
    if (Array.isArray(val) || isObject(val)) {
      fromContainers.push(...collectGenericConversations(val, nextMeta, `${ownId}-${key}`, depth + 1, hints));
    }
  }
  return fromContainers;
}

function inferGenericSource(fileName: string, metaHint: string, hints: readonly string[]): ImportSourceKind {
  const sample = `${fileName} ${metaHint} ${hints.slice(0, 10).join(" ")}`;
  if (/gemini|bard/i.test(sample)) return "gemini";
  if (/claude|anthropic/i.test(sample)) return "claude";
  if (/chatgpt|openai|\bgpt[-_\s43]/i.test(sample)) return "chatgpt";
  return "text";
}

function analyzeGenericJson(raw: unknown, fileName = ""): ImportParseResult | null {
  const hints: string[] = [];
  const ownMeta: InheritedMeta = isObject(raw) ? mergeMeta({}, raw) : {};
  // B21: a file named like an extension's combined export is one too, for its undated messages (topicMode).
  const rootMeta: InheritedMeta = /combined/i.test(fileName) ? { ...ownMeta, combinedName: true } : ownMeta;
  const conversations = collectGenericConversations(raw, rootMeta, "json", 0, hints);
  if (conversations.length === 0) return null;
  const source = inferGenericSource(fileName, rootMeta.sourceHint ?? "", hints);
  return result(source, conversations, false);
}

/** Parses JSON, tolerating trailing commas before `]` or `}` and newline-delimited JSON (JSONL). */
function tryParseJson(trimmed: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    // Retry after stripping trailing commas before `]` or `}` (common in hand-edited or extension-dumped JSON).
  }
  try {
    const cleaned = trimmed.replace(/,\s*([\]}])/g, "$1");
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch {
    // Check if it is JSONL (one JSON object per line).
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.every((line) => line.startsWith("{") && line.endsWith("}"))) {
    try {
      return { ok: true, value: lines.map((line) => JSON.parse(line) as unknown) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

// Entry points --------------------------------------------------------------------

function parseJson(raw: unknown, parseHtml: ParseHtml, fileName = ""): ImportParseResult {
  if (looksTangent(raw)) return result("tangent", [tangentConversation(raw)], true);
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.some(looksChatGpt)) return result("chatgpt", list.flatMap((item, index) => chatGptConversation(item, index) ?? []), true);
  if (list.some(looksClaude)) return result("claude", list.flatMap((item, index) => claudeConversation(item, index) ?? []), true);
  if (list.some(looksGeminiActivity)) {
    const turns = list.flatMap((item) => geminiActivityTurn(item, parseHtml) ?? []);
    // Takeout lists the newest first.
    const ordered = [...turns].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return result("gemini", geminiConversations(ordered), false);
  }
  const contents = geminiContents(raw);
  if (contents) return result("gemini", [contents], false);
  const analyzed = analyzeGenericJson(raw, fileName);
  if (analyzed) return analyzed;
  return fail("unsupported");
}

function parseHtmlExport(text: string, parseHtml: ParseHtml): ImportParseResult {
  const doc = parseHtml(text);
  const embedded = chatGptJsonFromHtml(doc);
  if (Array.isArray(embedded)) return parseJson(embedded, parseHtml);
  const turns = parseGeminiActivityHtml(doc);
  if (turns.length > 0) return result("gemini", geminiConversations(turns), false);
  // Any other page: its text as a transcript (a saved chat page with speaker labels).
  return parseText(htmlToText(doc.body ?? doc));
}

function parseText(text: string): ImportParseResult {
  const transcript = parseTranscript(text);
  if (!transcript) return fail("noMessages");
  return result(transcript.source, [transcript.conversation], false, transcript.guessedRoles);
}

export interface ParseImportOptions {
  /** The file's name, for its extension; pasted text has none. */
  fileName?: string;
  /** F14: the file's `lastModified` (ISO): the time of a conversation whose source has none of its own. */
  fileModifiedAt?: string | null;
  /** Tests (Node) pass jsdom's; the browser's DOMParser otherwise. */
  parseHtml?: ParseHtml;
}

/** Whether a conversation carries any date of its own (its own, or one of its messages'). */
export function hasOwnTime(conversation: ParsedConversation): boolean {
  return Boolean(conversation.createdAt || conversation.updatedAt || conversation.messages.some((message) => message.createdAt));
}

/** F14: each conversation's `timeSource`; one without a date of its own takes the file's time (`file`) or has none (`none`). */
function withTimeSources(parsed: ImportParseResult, fileModifiedAt: string | null): ImportParseResult {
  if (!parsed.ok) return parsed;
  const conversations = parsed.value.conversations.map((conversation): ParsedConversation => {
    if (hasOwnTime(conversation)) return { ...conversation, timeSource: "exact", fileTime: null };
    return fileModifiedAt ? { ...conversation, timeSource: "file", fileTime: fileModifiedAt } : { ...conversation, timeSource: "none", fileTime: null };
  });
  return { ok: true, value: { ...parsed.value, conversations } };
}

/** Parses an export or a pasted transcript. */
export function parseImport(text: string, options: ParseImportOptions = {}): ImportParseResult {
  return withTimeSources(parseImportText(text, options), isoTime(options.fileModifiedAt ?? null));
}

function parseImportText(text: string, options: ParseImportOptions): ImportParseResult {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed === "") return fail("empty");
  const name = (options.fileName ?? "").toLowerCase();
  const parseHtml = options.parseHtml ?? defaultParseHtml;
  if (name.endsWith(".json") || name.endsWith(".jsonl") || /^[[{]/.test(trimmed)) {
    const parsed = tryParseJson(trimmed);
    if (parsed.ok) return parseJson(parsed.value, parseHtml, options.fileName ?? "");
    // A .json that does not parse is not a transcript either.
    if (name.endsWith(".json") || name.endsWith(".jsonl")) return fail("unsupported");
  }
  if (name.endsWith(".html") || name.endsWith(".htm") || /^<(!doctype|html|head|body|div)/i.test(trimmed)) return parseHtmlExport(trimmed, parseHtml);
  return parseText(trimmed);
}
