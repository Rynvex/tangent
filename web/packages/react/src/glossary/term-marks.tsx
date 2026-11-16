/**
 * A glossary made ready to mark a transcript (F19 §2.3): the matcher (built
 * once per glossary), which terms each message uses (remembered per
 * message), and the underlined term. Loaded only once a conversation has
 * terms; `useTermMarking` asks for it.
 */
import { createTermMatcher, matchTermsInMarkdown, newTermScan, scanTerms, type Term } from "@tangent/client";
import type { ReactNode } from "react";
import { TERM_MARK_PREFIX, type MessageTerms, type TermMarking } from "../conversation/term-marking";
import TermMark from "./term-mark";

/** How many messages are remembered before the oldest half is dropped. */
const REMEMBERED_MESSAGES = 4000;

interface Remembered {
  text: string;
  /** The terms the text uses, in order, each with its last change: the same signature marks the same way. */
  signature: string;
  terms: MessageTerms | null;
}

/**
 * What each message was last marked with, across glossaries: when a glossary
 * changes, a message whose own terms did not keeps the object it had, so its
 * row (and its parsed Markdown) is left alone. Message ids are unique across
 * conversations.
 */
const remembered = new Map<string, Remembered>();

function remember(messageId: string, entry: Remembered): void {
  if (remembered.size >= REMEMBERED_MESSAGES && !remembered.has(messageId)) for (const key of [...remembered.keys()].slice(0, REMEMBERED_MESSAGES / 2)) remembered.delete(key);
  remembered.set(messageId, entry);
}

export function makeTermMarking(terms: readonly Term[], onOpen: (term: Term) => void): TermMarking {
  const matcher = createTermMatcher(terms);
  const byId = new Map(terms.map((term) => [term.id, term]));
  /** This glossary's answers, by message: asking again for the same text does no matching. */
  const answered = new Map<string, { text: string; terms: MessageTerms | null }>();
  const own: MessageTerms = {
    scan: () => {
      let state = newTermScan();
      return (text) => {
        const scanned = scanTerms(matcher, text, state);
        state = scanned.state;
        return scanned.matches.map((match) => ({ start: match.start, end: match.end, key: `${TERM_MARK_PREFIX}${match.termId}` }));
      };
    },
    render(key: string, children: ReactNode) {
      const term = byId.get(key.slice(TERM_MARK_PREFIX.length));
      return term ? (
        <TermMark term={term} onOpen={onOpen}>
          {children}
        </TermMark>
      ) : (
        children
      );
    },
  };
  return {
    forMessage(messageId, text) {
      const now = answered.get(messageId);
      if (now && now.text === text) return now.terms;
      const signature = matchTermsInMarkdown(matcher, text)
        .map((match) => `${match.termId}@${byId.get(match.termId)?.updatedAt ?? ""}`)
        .join("|");
      const before = remembered.get(messageId);
      // The same terms as last time, unchanged: what marked the message then marks it the same way now.
      const result = signature === "" ? null : before && before.text === text && before.signature === signature && before.terms ? before.terms : own;
      remember(messageId, { text, signature, terms: result });
      if (answered.size >= REMEMBERED_MESSAGES) answered.clear();
      answered.set(messageId, { text, terms: result });
      return result;
    },
  };
}

/** Forgets what every message was marked with (tests start clean). */
export function forgetTermMarks(): void {
  remembered.clear();
}
