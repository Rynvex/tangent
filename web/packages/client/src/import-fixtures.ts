/**
 * The design's five sessions about one Postgres pool (F14 設計稿): A and C
 * from ChatGPT, B and E from Claude, D a Markdown file without dates.
 * Times are UTC; B starts while A is still going (the interleave).
 */
import type { ImportSourceKind, ParsedConversation, ParsedMessage } from "./import-tree";
import type { TimelineSession } from "./import-timeline";

export const at = (day: number, hour: number, minute: number) => new Date(Date.UTC(2026, 7, day, hour, minute)).toISOString();

/** Messages alternating user / assistant from the user's, with their times (null: undated). */
export function messages(prefix: string, times: ReadonlyArray<string | null>, text: (n: number) => string = (n) => `${prefix} message ${n}.`): ParsedMessage[] {
  return times.map((time, index) => ({
    externalId: `${prefix}${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: text(index + 1),
    versions: 1,
    ...(time ? { createdAt: time } : {}),
  }));
}

export function conversation(id: string, title: string, list: ParsedMessage[], extra: Partial<ParsedConversation> = {}): ParsedConversation {
  const dated = list.flatMap((message) => (message.createdAt ? [message.createdAt] : []));
  return { id, title, createdAt: dated[0] ?? null, updatedAt: dated.at(-1) ?? null, messages: list, branches: [], skippedBranches: 0, timeSource: dated.length > 0 ? "exact" : "none", fileTime: null, ...extra };
}

export function session(key: string, conv: ParsedConversation, source: ImportSourceKind, pickOrder: number, manualTime: string | null = null): TimelineSession {
  return { key, conversation: conv, source, fileName: `${key}.json`, pickOrder, manualTime };
}

/** A: 08/12 14:20–18:02, 12 messages, a 2 h 37 min pause after #4 (14:58 → 17:35), a regenerated #6. */
export function sessionA(): TimelineSession {
  const times = [at(12, 14, 20), at(12, 14, 25), at(12, 14, 52), at(12, 14, 58), at(12, 17, 35), at(12, 17, 36), at(12, 17, 40), at(12, 17, 44), at(12, 17, 50), at(12, 17, 55), at(12, 18, 0), at(12, 18, 2)];
  const list = messages("a", times, (n) => (n === 12 ? "default_pool_size 20、transaction mode。應用端關掉 prepared statements。" : n === 1 ? "PgBouncer 要用哪種 pool mode？" : `A 第 ${n} 則。`));
  return session("A", conversation("ca", "PG 連線池設定", list, { branches: [{ anchorExternalId: "a5", reason: "regenerate", messages: [{ role: "assistant", content: "舊的回答。" }] }] }), "chatgpt", 0);
}

/** B: 08/12 15:10–15:22, 4 messages (inside A). */
export function sessionB(): TimelineSession {
  const list = messages("b", [at(12, 15, 10), at(12, 15, 12), at(12, 15, 20), at(12, 15, 22)], (n) => (n === 4 ? "不能用 session 層級的 SET；改用 SET LOCAL。其他照舊。" : `B 第 ${n} 則。`));
  return session("B", conversation("cb", "PgBouncer transaction mode 的限制", list), "claude", 1);
}

/** C: 08/15 10:05–11:40, 18 messages. */
export function sessionC(): TimelineSession {
  const times = Array.from({ length: 18 }, (_, i) => at(15, 10, 5 + i * 5));
  return session("C", conversation("cc", "高併發壓測與鎖等待", messages("c", times)), "chatgpt", 2);
}

/** D: no dates, the file's time 08/18. */
export function sessionD(): TimelineSession {
  const list = messages("d", Array.from({ length: 12 }, () => null), (n) => (n === 12 ? "調整後 TPS 1,840、p95 210ms。" : `D 第 ${n} 則。`));
  return session("D", conversation("壓測筆記", "壓測筆記", list, { timeSource: "file", fileTime: at(18, 9, 0) }), "markdown", 3);
}

/** E: 08/20 21:00–21:35, 8 messages. */
export function sessionE(): TimelineSession {
  const times = Array.from({ length: 8 }, (_, i) => at(20, 21, i * 5));
  return session("E", conversation("ce", "最終設定檔", messages("e", times)), "claude", 4);
}

export const designSessions = () => [sessionA(), sessionB(), sessionC(), sessionD(), sessionE()];

/** A session of `n` dated messages one minute apart from `start` (no pauses). */
export function sized(key: string, n: number, start: string, pickOrder = 0): TimelineSession {
  const base = Date.parse(start);
  const times = Array.from({ length: n }, (_, i) => new Date(base + i * 60_000).toISOString());
  return session(key, conversation(`c-${key}`, `Session ${key}`, messages(key.toLowerCase(), times)), "chatgpt", pickOrder);
}
