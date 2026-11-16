/** Test helpers shared by this package's own tests; not exported (the public mock lives in ./testing). */
import type { TranslateFn } from "./i18n-keys";
import type { Message, MessageRole, MessageStatus, MessageKind } from "./types";

/** Echoes the key and its params, so tests can assert which message was chosen. */
export const echoT: TranslateFn = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

/** A finished chat message with the given id and role. */
export function message(
  id: string,
  role: MessageRole,
  over: { status?: MessageStatus; kind?: MessageKind; content?: string; seq?: number } = {},
): Message {
  return {
    id,
    seq: over.seq ?? 0,
    lineId: "l1",
    role,
    kind: over.kind ?? "chat",
    content: over.content ?? id,
    status: over.status ?? "done",
    meta: {},
    hostMeta: {},
    createdAt: "",
    pinned: false,
  };
}
