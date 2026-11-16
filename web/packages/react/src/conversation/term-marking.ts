/**
 * What a transcript needs to mark a glossary's terms in its replies (F19
 * §2.3). Only the shape lives here (the rows are in the main bundle); the
 * matcher and the underline's parts load once a conversation has terms
 * (`glossary/term-marks.tsx`).
 */
import type { ReactNode } from "react";
import type { MarkScanner } from "../markdown";

/** The keys of a term's marks start with this, apart from the excerpt anchors' (a branch's line id). */
export const TERM_MARK_PREFIX = "term:";

/** What marks the terms of one message. */
export interface MessageTerms {
  /** The scan of the reply's plain text: each term once, the longest at each place, a limit per reply. */
  scan: MarkScanner;
  /** A marked term: its words with the underline and its explanation on hover, focus or tap. */
  render(key: string, children: ReactNode): ReactNode;
}

export interface TermMarking {
  /**
   * What marks this message's text, or null when no term appears in it. It is
   * the same object for as long as the terms that appear in the text (and
   * what they say) stay the same, whatever else changes in the glossary: a
   * new term re-renders only the replies that use it. Asking again for the
   * same text costs a lookup.
   */
  forMessage(messageId: string, text: string): MessageTerms | null;
}
