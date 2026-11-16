/**
 * The transcript's side of a glossary (F19 §2.3), small enough for the first
 * page: it reads the tree's terms and, only once there is one, loads the
 * matcher and the underline's parts.
 */
import type { Term } from "@tangent/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TermMarking } from "../conversation/term-marking";
import { useTerms } from "../data/glossary-query";

type Make = (terms: readonly Term[], onOpen: (term: Term) => void) => TermMarking;

let loaded: Make | null = null;

/**
 * What marks the tree's terms in its replies, or null: while the feature is
 * off (nothing is asked then), while the tree has no terms (nothing is
 * loaded then), and until the matcher has arrived. The same object for as
 * long as the terms stay the same, so memoised rows keep still. When they
 * change, a reply takes its new marks only if its own terms changed, and
 * only once it is in view (`MarkdownContent`): a long conversation never
 * re-parses hundreds of replies at once.
 */
export function useTermMarking(rootLineId: string | null, enabled: boolean, onOpen: (termId: string) => void): TermMarking | null {
  const terms = useTerms(rootLineId, enabled).data?.terms;
  const some = enabled && terms !== undefined && terms.length > 0;
  const [make, setMake] = useState<Make | null>(() => loaded);
  useEffect(() => {
    if (!some || make) return undefined;
    let current = true;
    void import("./term-marks").then(
      (module) => {
        loaded = module.makeTermMarking;
        if (current) setMake(() => module.makeTermMarking);
      },
      // Without the matcher the replies stay as they are.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [some, make]);
  const latest = useRef(onOpen);
  latest.current = onOpen;
  return useMemo(() => (some && make && terms ? make(terms, (term) => latest.current(term.id)) : null), [some, make, terms]);
}
