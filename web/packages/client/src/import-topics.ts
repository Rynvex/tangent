/**
 * B21: one long list of imported messages cut into conversations where the
 * topic changes, without a model. A combined export (a whole folder of chats
 * in one `dialogue`, no per-message times) is cut at every round whose
 * question shares no word with the conversation so far nor with the round
 * just before; a long list without times is cut the same way once a
 * conversation has 20 messages. Whatever stays over 500 messages (one branch's
 * limit) is cut at a round boundary. Pure and deterministic.
 */
import { IMPORT_MAX_BRANCH_MESSAGES } from "./b18-routes";
import type { ParsedMessage } from "./import-tree";
import { DECOMPOSE_STOPWORDS, HAN, orderedTerms, orderedTermsAt, type PlacedTerm } from "./text-terms";

/** `combined`: a combined export; `long`: an undated list over the branch limit. */
export type TopicSplitMode = "combined" | "long";

/** In a `long` list a cut needs this many messages since the last one. */
export const TOPIC_LONG_MIN_MESSAGES = 20;
/** Reply runes counted into a conversation's or a unit's words. */
const SEGMENT_REPLY_RUNES = 300;
/** Reply runes counted into the previous round's words of a B21 cut (follow-ups often quote the reply). */
const PREVIOUS_REPLY_RUNES = 600;

/** Two-letter English words that are never a topic (two-letter acronyms like ui, db, ai are kept). */
const SHORT_ENGLISH_STOPWORDS = "to in on at by of or as is it be we he do no so up go me my us if an ok hi";
/**
 * Question and filler words of English, and words of Chinese replies and questions that name no topic (pure IIFEs:
 * a bundle that only reaches this file through the package's barrel leaves them out).
 */
const TOPIC_STOPWORDS: ReadonlySet<string> = /* @__PURE__ */ (() =>
  new Set(
    (
      `${SHORT_ENGLISH_STOPWORDS} ` +
      "please explain tell give example examples difference between need want know think make work good best way thing things something really much many very same other these those who where after before now well still only even because such each most may might must been were had him his her she our over under again too " +
      "比較 比较 說明 说明 建議 建议 例如 比如 通常 主要 包括 方式 方法 使用 部分 情況 情况 進行 进行 提供 如下 重點 重点 簡單 简单 總結 总结 注意 推薦 推荐 選擇 选择 了解 確認 确认 果是 果有 果要 果用 果想 開始 开始"
    ).split(" "),
  ))();
/** Han characters of function words: a pair holding one (是什, 般是, 外的) is no topic word. */
const FUNCTION_HAN: ReadonlySet<string> = /* @__PURE__ */ (() => new Set(Array.from("的了是嗎吗呢吧啊呀喔哦嘛么麼什怎誰谁哪這这那我你妳您他她它們们就都也還还很又才再而並并及與与和或跟把被讓让給给在有沒没不為为如但所因一個个些樣样得著着啦嗯請请謝谢可以")))();

/** Whether a word is left out of topic splitting. */
export function isTopicStopword(term: string): boolean {
  if (DECOMPOSE_STOPWORDS.has(term) || TOPIC_STOPWORDS.has(term)) return true;
  if (/^[0-9_-]+$/.test(term)) return true;
  return HAN.test(term) && Array.from(term).some((rune) => FUNCTION_HAN.has(rune));
}

/** The topic words of a text: decompose's words (orderedTerms) with two-letter acronyms and more stopwords. */
export const topicTerms = (text: string): string[] => orderedTerms(text, { minAsciiRunes: 2, isStopword: isTopicStopword });

/** topicTerms with each word's first position (`domain.importTopicTermsAt`). */
export const topicTermsAt = (text: string): PlacedTerm[] => orderedTermsAt(text, { minAsciiRunes: 2, isStopword: isTopicStopword });

/** One round: a question and the replies after it (replies before the first question open the first round). */
export interface ImportTurn {
  messages: ParsedMessage[];
  question: string;
  reply: string;
}

/** The messages in rounds, each starting at a user message (the lists are built in place: they never leave here unfinished). */
export function groupTurns(messages: readonly ParsedMessage[]): ImportTurn[] {
  const turns: ParsedMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([message]);
    else turns.at(-1)!.push(message);
  }
  return turns.map((list) => ({
    messages: list,
    question: list.find((message) => message.role === "user")?.content ?? "",
    reply: list.filter((message) => message.role === "assistant").map((message) => message.content).join("\n"),
  }));
}

/** Openings of a follow-up question (`domain.importFollowUpCues`): it stays with the current topic unless another claims it. */
const FOLLOW_UP_CUES = [
  "那", "還有", "还有", "如果", "再問", "再问", "承上", "繼續", "继续", "要怎麼", "要怎么", "這", "这", "它",
  "what about", "how about", "what if", "also", "and then", "so then",
];
/** Openings of a change of topic (`domain.importShiftCues`): the follow-up rule does not apply, only the words decide. */
const SHIFT_CUES = [
  "另外", "對了", "对了", "順便", "顺便", "換個", "换个", "離題", "离题", "另一個問題", "另一个问题", "再來一個", "再来一个",
  "我想問", "我想问", "想問", "想问", "請問", "请问",
  "by the way", "unrelated", "another question", "different question", "new question", "changing topic", "switching topic",
];
/** Words pointing back at the reply before, anywhere in the question (`domain.importReferents`). */
const REFERENTS = [
  "它", "這個", "这个", "那個", "那个", "上面", "上述", "剛剛", "刚刚", "剛才", "刚才", "前面", "這次", "这次", "最後", "最后",
  "the above", "that one", "this one", "your answer", "you said",
];
/** Weaker pointers back (也, 再: also inside 也許, 再生), counted only in a short question (`domain.importWeakReferents`). */
const WEAK_REFERENTS = ["也", "再", "還要", "还要", "還有", "还有", " it ", " also ", " again"];
/** Characters and words that make a sentence a question even without a mark (`domain.importInterrogativeRunes` / Words). */
const INTERROGATIVE_RUNES = "什怎哪誰谁嗎吗呢麼么";
const INTERROGATIVE_WORDS = /* @__PURE__ */ (() => new Set("what why how where when which who whom whose".split(" ")))();
/** Marks that an order was carried out (寫好了, done): a report-back after all (`domain.importDoneMarks`). */
const DONE_MARKS = ["好了", "完了", "done", "finished"];
/** Openings of an order (`domain.importImperatives`): a new ask, never a report-back. */
const IMPERATIVES = [
  "幫我", "帮我", "請", "请", "寫", "写", "給我", "给我", "做一", "畫", "画", "列出", "整理一", "產生", "生成", "翻譯", "翻译",
  "help me", "write", "give me", "make", "create", "show me", "list", "draw", "generate", "translate",
];
/** How far into a question a shift cue may come (那我想問 Docker…). */
const SHIFT_RUNES = 12;
/** Characters and words a statement has and a bare topic (Redis 快取) does not (`domain.importReportBackMarks`). */
const REPORT_BACK_MARKS = "了是到很沒没在不有好還还也已完對对錯错成會会能";
const REPORT_BACK_WORDS = /* @__PURE__ */ (() => new Set("is was it's its done now works worked still yes no not".split(" ")))();
/** The longest question that is a report-back when it asks and orders nothing. */
const REPORT_BACK_RUNES = 30;

/** A question's start as the cues see it: lower case, leading spaces and punctuation removed (`domain.cueStart`). */
const cueStart = (question: string) => question.toLowerCase().replace(/^[\s\p{P}\p{S}]+/u, "");

/** Whether a question opens like a follow-up. */
export function startsAsFollowUp(question: string): boolean {
  const start = cueStart(question);
  return FOLLOW_UP_CUES.some((cue) => start.startsWith(cue));
}

/** Whether a question opens like a change of topic: a shift cue at its start or within its first few runes. */
export function startsAsShift(question: string): boolean {
  const start = cueStart(question);
  const early = Array.from(start).slice(0, SHIFT_RUNES).join("");
  return SHIFT_CUES.some((cue) => start.startsWith(cue) || early.includes(cue));
}

/** Whether a question points back: 它, 那個, the above anywhere; the weaker 也, 再, 還要 only in a short question. */
export function hasReferent(question: string): boolean {
  const lower = question.toLowerCase();
  if (REFERENTS.some((cue) => lower.includes(cue))) return true;
  if (Array.from(question.trim()).length > REPORT_BACK_RUNES) return false;
  return WEAK_REFERENTS.some((cue) => lower.includes(cue));
}

/** The lower-case letter runs of a text (apostrophes kept). */
const englishWords = (text: string) => text.toLowerCase().split(/[^\p{L}']+/u);

/** Whether a text opens like an order and does not say it was carried out (幫我寫一個… yes; 寫好了, "Created the table, works now" no). */
function isOrder(text: string): boolean {
  if (!IMPERATIVES.some((cue) => cueStart(text).startsWith(cue))) return false;
  const lower = text.toLowerCase();
  return !DONE_MARKS.some((mark) => lower.includes(mark)) && !englishWords(text).some((word) => REPORT_BACK_WORDS.has(word));
}

/** Whether a question is a short statement rather than a question, an order or a bare topic (確實是 Seq Scan。): what the user found. */
export function isReportBack(question: string): boolean {
  const text = question.trim();
  if (text === "" || Array.from(text).length > REPORT_BACK_RUNES || isOrder(text) || Array.from(INTERROGATIVE_RUNES).some((r) => text.includes(r))) return false;
  if ("?？".includes(Array.from(text).at(-1)!)) return false;
  const words = englishWords(text);
  if (words.some((word) => INTERROGATIVE_WORDS.has(word))) return false;
  return words.some((word) => REPORT_BACK_WORDS.has(word)) || Array.from(REPORT_BACK_MARKS).some((mark) => text.includes(mark));
}

/** Whether a question reads as going on with the current topic (`domain.continuesTopic`). */
export const continuesTopic = (question: string): boolean => !startsAsShift(question) && (startsAsFollowUp(question) || isReportBack(question) || hasReferent(question));

const head = (text: string, runes: number) => Array.from(text).slice(0, runes).join("");

/** The conversation being cut: an accumulator local to splitByTopicShifts (grown in place, so 2,000 messages stay linear). */
interface Segment {
  messages: ParsedMessage[];
  terms: Set<string>;
  replied: boolean;
}

const emptySegment = (): Segment => ({ messages: [], terms: new Set(), replied: false });

function addTurn(segment: Segment, turn: ImportTurn): void {
  segment.messages.push(...turn.messages);
  for (const term of topicTerms(`${turn.question}\n${head(turn.reply, SEGMENT_REPLY_RUNES)}`)) segment.terms.add(term);
  segment.replied ||= turn.reply !== "";
}

/** Whether a round starts another conversation: the one so far was answered, and its question shares no topic word with it nor the round before. */
function isTopicShift(turn: ImportTurn, segment: Segment, previous: ReadonlySet<string>, mode: TopicSplitMode): boolean {
  if (!segment.replied || (mode === "long" && segment.messages.length < TOPIC_LONG_MIN_MESSAGES)) return false;
  if (startsAsFollowUp(turn.question)) return false;
  const asked = topicTerms(turn.question);
  return asked.length > 0 && asked.every((term) => !segment.terms.has(term) && !previous.has(term));
}

/** The messages cut where the topic changes (see the file comment); none for no messages. */
export function splitByTopicShifts(messages: readonly ParsedMessage[], mode: TopicSplitMode): ParsedMessage[][] {
  const out: ParsedMessage[][] = [];
  let segment = emptySegment();
  let previous: ReadonlySet<string> = new Set();
  for (const turn of groupTurns(messages)) {
    if (segment.messages.length > 0 && isTopicShift(turn, segment, previous, mode)) {
      out.push(segment.messages);
      segment = emptySegment();
    }
    addTurn(segment, turn);
    previous = new Set(topicTerms(`${turn.question}\n${head(turn.reply, PREVIOUS_REPLY_RUNES)}`));
  }
  return segment.messages.length > 0 ? [...out, segment.messages] : out;
}

// B22: threading -------------------------------------------------------------------------------------------------

/** One unit to thread: a round (or a whole conversation), with its title (often ""), question, reply and size. */
export interface ThreadUnit {
  title: string;
  question: string;
  reply: string;
  messages: number;
}

export interface ThreadOptions {
  /** A unit leaves the current topic only once it holds this many messages (the `long` mode's 20); 0 by default. */
  minMessages?: number;
  /** The conversation's title: its words weigh half (Postgres in a Postgres chat names no topic). */
  title?: string;
}

/** The weight a question must share with an earlier cluster to come back to it: two Han words, or one name (`domain.analyzeJoinThreshold`). */
const JOIN_THRESHOLD = 1.2;
/** What it must share with the current cluster to go on with it: one Han word (`domain.analyzeStayThreshold`). */
const STAY_THRESHOLD = 1.0;
const HAN_WEIGHT = 1.0;
const ASCII_WEIGHT = 1.5;
const TITLE_FACTOR = 0.5;
/** A word in more than half the units names the domain, not a topic. */
const COMMON_FACTOR = 0.5;
/** A Han word shared only with a cluster's recent answers counts this much; a name from the last answer counts in full. */
const RECENT_HAN_WEIGHT = 0.5;
/** How many of a cluster's latest units are its recent text. */
const RECENT_UNITS = 2;
/** From how many units a word in more than half of them is common. */
const COMMON_MIN_UNITS = 4;

const isAsciiTerm = (term: string) => /^[\x00-\x7F]+$/.test(term);

/**
 * `domain.analyzeTermWeights`: a Han pair weighs 1, an ASCII word 1.5; a word in more than half the units and a word of the
 * title weigh half. (Inverse document frequency does worse: a topic's own word is frequent because the topic is big.)
 */
export function termWeights(title: string, units: readonly ThreadUnit[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const unit of units) for (const term of new Set(topicTerms(unitText(unit, SEGMENT_REPLY_RUNES)))) df.set(term, (df.get(term) ?? 0) + 1);
  const titled = new Set(topicTerms(title));
  const weights = new Map<string, number>();
  for (const [term, count] of df) {
    let weight = isAsciiTerm(term) ? ASCII_WEIGHT : HAN_WEIGHT;
    if (units.length >= COMMON_MIN_UNITS && 2 * count > units.length) weight *= COMMON_FACTOR;
    if (titled.has(term)) weight *= TITLE_FACTOR;
    weights.set(term, weight);
  }
  return weights;
}

/** One topic while units are threaded (grown in place: local to threadUnits): the words of its questions, of its latest units only, and its size. */
interface Cluster {
  units: number[];
  /** The words of all its questions: what the topic is about. */
  asked: Set<string>;
  /** The words (question and answer) of its latest units only: short memory, so a reply's words do not snowball. */
  latest: Set<string>[];
  messages: number;
  replied: boolean;
}

const unitText = (unit: ThreadUnit, replyRunes: number) => `${unit.title}\n${unit.question}\n${head(unit.reply, replyRunes)}`;
const askedText = (unit: ThreadUnit) => `${unit.title}\n${unit.question}`;

function joinCluster(cluster: Cluster, index: number, unit: ThreadUnit): void {
  cluster.units.push(index);
  for (const term of topicTerms(askedText(unit))) cluster.asked.add(term);
  cluster.latest.push(new Set(topicTerms(unitText(unit, SEGMENT_REPLY_RUNES))));
  if (cluster.latest.length > RECENT_UNITS) cluster.latest.splice(0, cluster.latest.length - RECENT_UNITS);
  cluster.messages += unit.messages;
  cluster.replied ||= unit.reply !== "";
}

const isRecent = (cluster: Cluster, term: string) => cluster.latest.some((terms) => terms.has(term));

/** How a question relates to one cluster: the weight it shares and how many words it shares at all. */
interface Join {
  score: number;
  shared: number;
}

/** What a word of the question counts for the cluster; undefined when not shared (`domain.sharedWeight`). */
function sharedWeight(term: PlacedTerm, cluster: Cluster, weights: ReadonlyMap<string, number>): number | undefined {
  const weight = weights.get(term.text) ?? 0;
  if (cluster.asked.has(term.text)) return weight;
  if (!isRecent(cluster, term.text)) return undefined;
  return term.han ? RECENT_HAN_WEIGHT * weight : weight;
}

/**
 * `domain.joinScores`: shared Han pairs at consecutive positions are one recurring phrase (連線時 gives 連線 and 線時) and
 * count once, as their lightest pair (a phrase built on a title word is domain talk).
 */
function joinScores(asked: readonly PlacedTerm[], clusters: readonly Cluster[], weights: ReadonlyMap<string, number>): Join[] {
  return clusters.map((cluster) => {
    const join: Join = { score: 0, shared: 0 };
    let run = 0;
    let runAt = -2;
    for (const term of asked) {
      const weight = sharedWeight(term, cluster, weights);
      if (weight === undefined) continue;
      join.shared += 1;
      if (!term.han) {
        join.score += weight;
        continue;
      }
      if (term.at === runAt + 1) run = Math.min(run, weight);
      else {
        join.score += run;
        run = weight;
      }
      runAt = term.at;
    }
    join.score += run;
    return join;
  });
}

/** What a unit must share with a cluster to join it: less for the current one (going on) than for an earlier one (coming back). */
const joinThreshold = (j: number, current: number) => (j === current ? STAY_THRESHOLD : JOIN_THRESHOLD);

/** The cluster with the highest join score at or over its threshold: the current one on a tie, else the most recent; -1 when none. */
function bestJoin(joins: readonly Join[], clusters: readonly Cluster[], current: number): number {
  let best = -1;
  let bestScore = 0;
  clusters.forEach((cluster, j) => {
    const score = joins[j]!.score;
    if (score < joinThreshold(j, current) || score < bestScore) return;
    if (score > bestScore || j === current) {
      best = j;
      bestScore = score;
    } else if (best !== current && cluster.units.at(-1)! > clusters[best]!.units.at(-1)!) {
      best = j;
    }
  });
  return best;
}

const anotherClaims = (joins: readonly Join[], clusters: readonly Cluster[], current: number) =>
  clusters.some((_, j) => j !== current && joins[j]!.score >= joinThreshold(j, current));

/**
 * `domain.threadTarget`: the cluster a unit joins. A unit before any reply, one without topic words, one before
 * `minMessages`, or one whose every word the current cluster has (Docker 第 10 題 in a Docker chat) stays with the
 * current cluster. One that reads as going on (continuesTopic) stays unless another cluster
 * could take it by its words. Otherwise the cluster sharing the most weight with the question wins (the current one on a
 * tie, else the most recent), if that reaches its threshold; -1 starts another.
 */
function threadTarget(unit: ThreadUnit, clusters: readonly Cluster[], current: number, weights: ReadonlyMap<string, number>, minMessages: number): number {
  const cur = clusters[current]!;
  if (!cur.replied || cur.messages < minMessages) return current;
  const asked = topicTermsAt(askedText(unit));
  if (asked.length === 0) return current;
  const joins = joinScores(asked, clusters, weights);
  if (joins[current]!.shared === asked.length) return current;
  if (continuesTopic(unit.question) && !anotherClaims(joins, clusters, current)) return current;
  return bestJoin(joins, clusters, current);
}

/**
 * B22: the units threaded into topics, each topic its unit indices in order, topics in order of their first unit. Units
 * of one topic come together even when other topics came between them (A → B → A → C → A → B gives A: 0, 2, 4; B: 1, 5;
 * C: 3). The same algorithm as the server's `domain.AnalyzeImportDeterministic` (keep them equal).
 */
export function threadUnits(units: readonly ThreadUnit[], options: ThreadOptions = {}): number[][] {
  const minMessages = options.minMessages ?? 0;
  const weights = termWeights(options.title ?? "", units);
  const clusters: Cluster[] = [];
  let current = -1;
  units.forEach((unit, index) => {
    let target = current >= 0 ? threadTarget(unit, clusters, current, weights, minMessages) : -1;
    if (target < 0) {
      clusters.push({ units: [], asked: new Set(), latest: [], messages: 0, replied: false });
      target = clusters.length - 1;
    }
    joinCluster(clusters[target]!, index, unit);
    current = target;
  });
  return clusters.map((cluster) => [...cluster.units]);
}

/** One threaded topic of a message list: its messages (rounds in order) and the 1-based rounds it holds. */
export interface ThreadedTopic {
  messages: ParsedMessage[];
  rounds: number[];
}

/**
 * B22: the messages cut by topic like splitByTopicShifts, but a round that returns to an earlier topic joins it instead
 * of starting another conversation (A1 → B1 → A2 → C1 → A3 → B2 gives A1+A2+A3, B1+B2, C1). Topics are in order of
 * their first round; none for no messages.
 */
export function threadByTopicShifts(messages: readonly ParsedMessage[], mode: TopicSplitMode): ThreadedTopic[] {
  const turns = groupTurns(messages);
  const units = turns.map((turn) => ({ title: "", question: turn.question, reply: turn.reply, messages: turn.messages.length }));
  return threadUnits(units, { minMessages: mode === "long" ? TOPIC_LONG_MIN_MESSAGES : 0 }).map((indices) => ({
    messages: indices.flatMap((index) => turns[index]!.messages),
    rounds: indices.map((index) => index + 1),
  }));
}

/** The messages in lists of at most `limit`, cut between rounds (a round longer than the limit is cut inside). */
export function splitOverLimit(messages: readonly ParsedMessage[], limit: number = IMPORT_MAX_BRANCH_MESSAGES): ParsedMessage[][] {
  if (messages.length <= limit) return [[...messages]];
  const chunks: ParsedMessage[][] = [];
  let current: ParsedMessage[] = [];
  for (const turn of groupTurns(messages)) {
    if (current.length > 0 && current.length + turn.messages.length > limit) {
      chunks.push(current);
      current = [];
    }
    let rest = turn.messages;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current.push(...rest);
  }
  return current.length > 0 ? [...chunks, current] : chunks;
}
