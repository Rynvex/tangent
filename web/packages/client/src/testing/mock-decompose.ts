/**
 * The mock's `GET /lines/{id}/decompose`: a port of domain/decompose.go and
 * decompose_text.go (B18) — the same fixed word rules, no model — so the demo
 * shows the plans the reference server would. Since B18.1 both clean the
 * suggested tags with the same rules (`cleanSuggestedTags`, which is
 * domain.cleanSuggestedTags), so Chinese tags come as whole words.
 */
import type { DecomposePlan, DetourRange, RelatedLine, SeedCandidate } from "../b18-routes";
import { normalizeTag, TAG_MAX_RUNES } from "../b18-routes";
import { cleanSuggestedTags } from "../suggested-tags";
import { HAN, orderedTerms, TERM_SCAN_RUNES } from "../text-terms";
import type { Message } from "../types";

const MAX_MESSAGES = 2000;
const MAX_TAGS = 5;
const MAX_CUTS = 8;
const MAX_DETOURS = 8;
const MAX_SEEDS = 8;
const MAX_RELATED = 5;
const TIME_GAP_MS = 30 * 60_000;
const SHIFT_WINDOW = 6;
const SHIFT_EVERY = 12;
const SHIFT_OVERLAP = 0.15;
const DETOUR_MAX_ROUNDS = 4;
const TITLE_RUNES = 40;
const TEXT_RUNES = 200;
const CUE_RUNES = 300;

const SHIFT_CUES = ["另外", "順便問", "順便", "換個", "那如果", "另一個問題", "話說", "对了", "對了", "顺便", "by the way", "btw", "another question", "switching to", "on another note", "unrelated", "different topic", "new topic"];
const ERROR_CUES = ["error", "exception", "traceback", "panic:", "stack trace", "failed", "failure", "doesn't work", "does not work", "not working", "報錯", "报错", "錯誤", "错误", "失敗", "失败", "異常", "异常", "跑不起來", "連不上", "连不上"];
const DEFINITION_CUES = ["what is", "what's", "what are", "what does", "explain", "define", "meaning of", "什麼是", "什么是", "是什麼", "是什么", "是指", "的意思", "解釋一下", "解释一下"];
const OPEN_ITEM_CUES = ["todo", "to do", "next step", "open question", "to confirm", "待確認", "待确认", "待辦", "待办", "下一步", "未解", "還沒", "还没"];

const cutRunes = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trim()}…`;
};
const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

export { orderedTerms };

const termSet = (text: string) => new Set(orderedTerms(text));

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = b.size < a.size ? [b, a] : [a, b];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const term of small) if (large.has(term)) shared += 1;
  return shared / small.size;
}

const cueStart = (text: string) => text.toLowerCase().replace(/^[\s\p{P}\p{S}]+/u, "");
const startsWithCue = (text: string, cues: readonly string[]) => cues.some((cue) => cueStart(text).startsWith(cue));
const containsCue = (text: string, cues: readonly string[]) => {
  const head = Array.from(text).slice(0, CUE_RUNES).join("").toLowerCase();
  return cues.some((cue) => head.includes(cue));
};

function firstSentence(text: string, max: number): string {
  const runes = Array.from(text.trim());
  let end = runes.length;
  for (let i = 0; i < runes.length; i += 1) {
    const r = runes[i]!;
    if (r === "\n" || r === "。" || r === "！" || r === "？") {
      end = i + 1;
      break;
    }
    if ((r === "." || r === "!" || r === "?") && (i + 1 === runes.length || /\s/.test(runes[i + 1]!))) {
      end = i + 1;
      break;
    }
  }
  return cutRunes(flatten(runes.slice(0, end).join("")), max);
}

function lastQuestion(text: string, max: number): string {
  const trimmed = text.trim();
  if (!trimmed.endsWith("?") && !trimmed.endsWith("？")) return "";
  const runes = Array.from(trimmed);
  let start = 0;
  for (let i = runes.length - 2; i >= 0; i -= 1) {
    const r = runes[i]!;
    if (r === "\n" || r === "。" || r === "！" || r === "？" || ((r === "." || r === "!" || r === "?") && /\s/.test(runes[i + 1] ?? ""))) {
      start = i + 1;
      break;
    }
  }
  return cutRunes(flatten(runes.slice(start).join("")), max);
}

function listItems(text: string): string[] {
  return Array.from(text)
    .slice(0, TERM_SCAN_RUNES)
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^(?:[-*•] |\d{1,3}[.)] )(.*)$/.exec(line);
      return match && match[1]!.trim() ? [match[1]!.trim()] : [];
    });
}

const isConversation = (message: Message) => message.status === "done" && message.kind === "chat" && (message.role === "user" || message.role === "assistant");
const canAnchor = (message: Message) => isConversation(message) || (message.kind === "branch_card" && message.status === "done");

export interface MockDecomposeInput {
  lineId: string;
  title: string;
  messages: readonly Message[];
  /** Messages that already hold a chapter cut. */
  cutMessageIds: ReadonlySet<string>;
  /** The tree's own tags (never suggested again). */
  tags: readonly string[];
  /** The tags the tenant's unarchived main lines use (kept as they are when the tags are cleaned). */
  tenantTags: readonly string[];
  related: readonly RelatedLine[];
}

/** The plan `domain.BuildDecomposePlan` makes, in the wire shape. */
export function buildDecomposePlan(input: MockDecomposeInput): DecomposePlan {
  const all = [...input.messages].sort((a, b) => a.seq - b.seq);
  const truncated = all.length > MAX_MESSAGES;
  const messages = all.slice(0, MAX_MESSAGES);
  const terms = messages.map((message) => (isConversation(message) ? termSet(message.content) : new Set<string>()));
  const isUser = (i: number) => i >= 0 && i < messages.length && isConversation(messages[i]!) && messages[i]!.role === "user";
  return {
    lineId: input.lineId,
    suggestedTags: suggestTags(messages, input.title, input.tags, input.tenantTags),
    chapterCuts: suggestCuts(messages, terms, isUser, input.cutMessageIds),
    detourRanges: suggestDetours(messages, terms, isUser, input.title, truncated),
    seedCandidates: suggestSeeds(messages),
    relatedLines: input.related.slice(0, MAX_RELATED).map((line) => ({ ...line, sharedTags: [...line.sharedTags] })),
    truncated,
  };
}

function suggestTags(messages: readonly Message[], title: string, existing: readonly string[], tenantTags: readonly string[]): string[] {
  const score = new Map<string, number>();
  const sources = new Map<string, number>();
  const order: string[] = [];
  const count = (found: readonly string[], weight: number) => {
    for (const term of found) {
      if (!score.has(term)) order.push(term);
      score.set(term, (score.get(term) ?? 0) + weight);
      sources.set(term, (sources.get(term) ?? 0) + 1);
    }
  };
  count(orderedTerms(title), 3);
  messages.slice(0, 6).forEach((message) => isConversation(message) && count(orderedTerms(message.content), 1));
  const have = new Set(existing.map(normalizeTag));
  const candidates = order.filter((term) => {
    const tag = normalizeTag(term);
    return (sources.get(term) ?? 0) >= 2 && tag !== "" && !have.has(tag) && Array.from(tag).length <= TAG_MAX_RUNES;
  });
  // A stable sort, as sort.SliceStable; cleaned before the cap, as the server does.
  const ranked = candidates
    .map((term, index) => ({ term, index }))
    .sort((a, b) => (score.get(b.term) ?? 0) - (score.get(a.term) ?? 0) || a.index - b.index)
    .map(({ term }) => normalizeTag(term));
  return cleanSuggestedTags(ranked, title, tenantTags, existing, MAX_TAGS);
}

function windowOf(terms: ReadonlyArray<ReadonlySet<string>>, from: number, to: number): Set<string> {
  const out = new Set<string>();
  for (let i = Math.max(from, 0); i < to && i < terms.length; i += 1) for (const term of terms[i]!) out.add(term);
  return out;
}

function suggestCuts(messages: readonly Message[], terms: ReadonlyArray<ReadonlySet<string>>, isUser: (i: number) => boolean, cut: ReadonlySet<string>) {
  const out: DecomposePlan["chapterCuts"] = [];
  let since = 0;
  for (let i = 0; i < messages.length && out.length < MAX_CUTS; i += 1) {
    const message = messages[i]!;
    since += 1;
    if (cut.has(message.id)) since = 0;
    if (i === 0 || !isUser(i) || cut.has(message.id)) continue;
    let reason = "";
    if (Date.parse(message.createdAt) - Date.parse(messages[i - 1]!.createdAt) >= TIME_GAP_MS) reason = "time_gap";
    else if (startsWithCue(message.content, SHIFT_CUES)) reason = "topic_shift";
    else if (since >= SHIFT_EVERY && i >= SHIFT_WINDOW && i + SHIFT_WINDOW <= messages.length) {
      const before = windowOf(terms, i - SHIFT_WINDOW, i);
      const after = windowOf(terms, i, i + SHIFT_WINDOW);
      if (before.size >= 5 && after.size >= 5 && overlap(before, after) < SHIFT_OVERLAP) reason = "topic_shift";
    }
    if (!reason) continue;
    out.push({ messageId: message.id, seq: message.seq, title: cutRunes(flatten(message.content), TITLE_RUNES), reason });
    since = 0;
  }
  return out;
}

function suggestDetours(messages: readonly Message[], terms: ReadonlyArray<ReadonlySet<string>>, isUser: (i: number) => boolean, title: string, truncated: boolean): DetourRange[] {
  const out: DetourRange[] = [];
  const topic = termSet(title);
  for (let i = 0; i < messages.length && i < 2; i += 1) for (const term of terms[i]!) topic.add(term);
  const cuedAt = (i: number) => containsCue(messages[i]!.content, ERROR_CUES) || (Array.from(messages[i]!.content).length <= 80 && containsCue(messages[i]!.content, DEFINITION_CUES));
  const endOf = (start: number, cued: boolean): number => {
    let end = -1;
    for (let round = 0; round < DETOUR_MAX_ROUNDS; round += 1) {
      const user = start + 2 * round;
      const reply = user + 1;
      if (!isUser(user) || reply >= messages.length || !isConversation(messages[reply]!) || messages[reply]!.role !== "assistant") break;
      end = reply;
      const next = reply + 1;
      if (next >= messages.length) return cued && !truncated ? end : -1;
      if (!isUser(next)) return -1;
      if (overlap(terms[next]!, topic) > 0) return end;
    }
    return -1;
  };
  for (let i = 2; i < messages.length && out.length < MAX_DETOURS; i += 1) {
    if (!isUser(i)) continue;
    const cued = cuedAt(i);
    if (!cued && (terms[i]!.size === 0 || overlap(terms[i]!, topic) > 0)) continue;
    const end = endOf(i, cued);
    if (end < 0) continue;
    let anchor = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (canAnchor(messages[j]!)) {
        anchor = j;
        break;
      }
    }
    if (anchor < 0) continue;
    const first = messages[i]!;
    const subject = cutRunes(flatten(first.content), TITLE_RUNES);
    out.push({
      anchorMessageId: messages[anchor]!.id,
      fromMessageId: first.id,
      toMessageId: messages[end]!.id,
      messageCount: end - i + 1,
      purpose: HAN.test(Array.from(first.content).slice(0, CUE_RUNES).join("")) ? `了解：${subject}` : `Look into: ${subject}`,
      suggestedConclusion: firstSentence(messages[end]!.content, TEXT_RUNES),
    });
    i = end;
  }
  return out;
}

function suggestSeeds(messages: readonly Message[]): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  const add = (message: Message, raw: string, reason: string) => {
    const text = raw.trim();
    if (!text || out.some((seed) => seed.text === text) || out.length === MAX_SEEDS) return;
    out.push({ messageId: message.id, text, reason });
  };
  for (let i = messages.length - 1; i >= 0 && out.length < MAX_SEEDS; i -= 1) {
    const message = messages[i]!;
    if (!isConversation(message) || message.role !== "assistant") continue;
    for (const item of listItems(message.content)) {
      if (item.endsWith("?") || item.endsWith("？") || containsCue(item, OPEN_ITEM_CUES)) add(message, cutRunes(flatten(item), TEXT_RUNES), "open_item");
    }
    add(message, lastQuestion(message.content, TEXT_RUNES), "question");
  }
  const position = new Map(messages.map((message, index) => [message.id, index]));
  return out.map((seed, index) => ({ seed, index })).sort((a, b) => (position.get(a.seed.messageId) ?? 0) - (position.get(b.seed.messageId) ?? 0) || a.index - b.index).map(({ seed }) => seed);
}
