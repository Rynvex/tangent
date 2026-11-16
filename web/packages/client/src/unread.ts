import { sortBySeq } from "./text";
import type { Message } from "./types";

/**
 * Where a line's unread part starts: the server adds one unread per finished
 * reply, so it is the oldest of the last `unread` finished assistant chat
 * messages (by seq). The divider "n 則未讀" goes before it.
 */
export function firstUnreadId(messages: readonly Message[], unread: number): string | null {
  if (unread <= 0) return null;
  const replies = sortBySeq(messages).filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done");
  return replies[Math.max(0, replies.length - unread)]?.id ?? null;
}
