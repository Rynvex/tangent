/**
 * F17 S4: a session's question-and-answer rounds as the mind map's node
 * inspector lists them (「提問：…」「回覆：…」), before an analysis (a whole
 * conversation) and after it (a round's own session). Pure.
 */
import { sessionMessageTimes, type TimelineSession } from "./import-timeline";
import { groupTurns } from "./import-topics";

/** One round of a session. */
export interface SessionRound {
  /** Its place in the session (1-based). */
  n: number;
  /** When it was asked (ISO, with a time the user set applied), or null without a time. */
  time: string | null;
  question: string;
  answer: string;
  /** Its messages' ids, in order. */
  messageIds: string[];
  /** The message a branch hangs after when it forks after this round: the last reply (else the last message). */
  anchorId: string;
}

/** The session's rounds, the messages in `removed` left out. */
export function extractSessionRounds(session: TimelineSession, removed: ReadonlySet<string> = new Set()): SessionRound[] {
  const times = sessionMessageTimes(session);
  const kept = session.conversation.messages.filter((message) => !removed.has(message.externalId));
  return groupTurns(kept).map((turn, index) => {
    const ids = turn.messages.map((message) => message.externalId);
    const anchor = [...turn.messages].reverse().find((message) => message.role === "assistant") ?? turn.messages.at(-1)!;
    return {
      n: index + 1,
      time: ids.map((id) => times.get(id)).find((time) => time !== undefined) ?? null,
      question: turn.question,
      answer: turn.reply,
      messageIds: ids,
      anchorId: anchor.externalId,
    };
  });
}
