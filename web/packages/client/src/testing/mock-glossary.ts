/**
 * The mock's glossary (B24), as the server runs it (store/terms.go,
 * docs/devlog/B24-glossary.md): one term per key in a conversation, cleaned
 * texts, 300 new terms at most, archived conversations refuse writes, a
 * save from an aside keeps it (`terms.changed`, then `branch.changed{kept}`),
 * and the tenant-wide search puts the terms that start with the query first.
 */
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import { DEFAULT_TERM_LIMITS, type CreateTermInput, type Term, type TermChangeKind, type TermList, type TermSearchPage, type TermSearchQuery, type TermWriteResult, type UpdateTermInput } from "../glossary-routes";
import { cleanTerm, cleanTermExplanation, normalizeTermKey, rankTerms } from "../glossary-rules";
import type { BranchView } from "../types";
import { address, type MockContext } from "./mock-context";
import { mockSourceLabel } from "./mock-notes";
import { findLine, messagesOf, newId, rootOf, withBranch } from "./mock-store";

/** store.termListCap: one conversation's listing (an attach may bring it over the cap for new terms). */
const TERM_LIST_CAP = 1000;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

export interface MockGlossary {
  list(lineId: string): TermList;
  create(lineId: string, input: CreateTermInput): TermWriteResult;
  update(termId: string, input: UpdateTermInput): { term: Term };
  remove(termId: string): void;
  search(query: TermSearchQuery): TermSearchPage;
}

const runes = (text: string) => Array.from(text).length;
const byKey = (a: Term, b: Term) => (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : a.id < b.id ? -1 : 1);

export function createMockGlossary(ctx: MockContext): MockGlossary {
  const limits = DEFAULT_TERM_LIMITS;
  function require(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "glossary")) throw new TangentError(404, "the glossary feature is off", "feature_disabled", { feature: "glossary" });
  }
  const rootFor = (lineId: string) => rootOf(findLine(ctx.state(), lineId));
  const isArchived = (root: string) => Boolean(ctx.state().lines.find((line) => line.id === root)?.archivedAt);
  function writable(root: string): void {
    if (isArchived(root)) throw new TangentError(409, "the conversation is archived", "archived");
  }
  /** domain.CleanTerm: the term on one line and its key. */
  function termOf(raw: string): { term: string; key: string } {
    const term = cleanTerm(raw);
    const key = normalizeTermKey(term);
    if (key === "") throw new TangentError(400, "a term must not be empty", "invalid_input", { field: "term" });
    if (runes(term) > limits.termMaxRunes) throw new TangentError(422, "the term is too long", "too_long", { field: "term", max: limits.termMaxRunes });
    return { term, key };
  }
  /** domain.CleanTermExplanation. */
  function explanationOf(raw: string): string {
    const explanation = cleanTermExplanation(raw);
    if (explanation === "") throw new TangentError(400, "an explanation must not be empty", "invalid_input", { field: "explanation" });
    if (runes(explanation) > limits.explanationMaxRunes) throw new TangentError(422, "the explanation is too long", "too_long", { field: "explanation", max: limits.explanationMaxRunes });
    return explanation;
  }
  function find(termId: string): Term {
    const term = ctx.state().terms.find((item) => item.id === termId);
    if (!term) throw new TangentError(404, "term not found", "term_not_found");
    return term;
  }
  function publish(term: Term, change: TermChangeKind): void {
    ctx.bus.publish("terms.changed", { lineId: term.sourceLineId, rootLineId: term.rootLineId }, { rootLineId: term.rootLineId, termId: term.id, change });
  }
  /** store.keepSourceAside: the aside the term is saved from, kept now; null for any other line or one kept already. */
  function keptAside(root: string, lineId: string): BranchView | null {
    if (lineId === root) return null;
    const branch = ctx.state().branches.find((item) => item.lineId === lineId);
    if (!branch || branch.kind !== "aside" || branch.keptAt) return null;
    return { ...branch, keptAt: ctx.now() };
  }

  return {
    list(lineId) {
      require();
      const root = rootFor(lineId);
      const terms = ctx.state().terms.filter((term) => term.rootLineId === root).sort(byKey).slice(0, TERM_LIST_CAP);
      return { rootLineId: root, terms, limits: { ...limits } };
    },

    create(lineId, input) {
      require();
      const { term: name, key } = termOf(String(input.term ?? ""));
      const explanation = explanationOf(String(input.explanation ?? ""));
      const root = rootFor(lineId);
      writable(root);
      const kept = keptAside(root, lineId);
      const sourceMessageId = (input.sourceMessageId ?? "").trim();
      if (sourceMessageId !== "" && !messagesOf(ctx.state(), lineId).some((message) => message.id === sourceMessageId)) throw new TangentError(404, "the message is not on this line", "message_not_found");
      const sourceLabel = mockSourceLabel(ctx.state(), root, { sourceLineId: lineId, sourceMessageId });
      const existing = ctx.state().terms.find((item) => item.rootLineId === root && item.termKey === key);
      if (existing && !input.replace) throw new TangentError(409, `this conversation already has the term ${existing.term}`, "term_exists", { term: existing });
      const now = ctx.now();
      let term: Term;
      if (existing) {
        // A replace overwrites the explanation and the source; the term keeps its spelling.
        term = { ...existing, explanation, sourceLineId: lineId, sourceMessageId, sourceLabel, updatedAt: now };
        const state = ctx.state();
        ctx.commit({ ...state, terms: state.terms.map((item) => (item.id === term.id ? term : item)) });
      } else {
        if (ctx.state().terms.filter((item) => item.rootLineId === root).length >= limits.maxTotal) {
          throw new TangentError(409, "this conversation has reached its limit of terms", "term_limit", { limit: limits.maxTotal });
        }
        const [id, next] = newId(ctx.state(), "term");
        term = { id, rootLineId: root, term: name, termKey: key, explanation, sourceLineId: lineId, sourceMessageId, sourceLabel, createdBy: "mock-user", createdAt: now, updatedAt: now };
        ctx.commit({ ...next, terms: [...next.terms, term] });
      }
      if (kept) ctx.commit(withBranch(ctx.state(), kept));
      publish(term, existing ? "updated" : "created");
      if (kept) ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "kept", branch: kept });
      return { term, change: existing ? "updated" : "created", ...(kept ? { keptBranch: kept } : {}) };
    },

    update(termId, input) {
      require();
      if (input.term === undefined && input.explanation === undefined) throw new TangentError(400, "give a term or an explanation to change", "invalid_input");
      const before = find(termId);
      writable(before.rootLineId);
      const renamed = input.term !== undefined ? termOf(input.term) : null;
      const explanation = input.explanation !== undefined ? explanationOf(input.explanation) : before.explanation;
      const clash = renamed ? ctx.state().terms.find((item) => item.rootLineId === before.rootLineId && item.termKey === renamed.key && item.id !== termId) : undefined;
      if (clash) throw new TangentError(409, `this conversation already has the term ${clash.term}`, "term_exists", { term: clash });
      const term: Term = { ...before, ...(renamed ? { term: renamed.term, termKey: renamed.key } : {}), explanation, updatedAt: ctx.now() };
      const state = ctx.state();
      ctx.commit({ ...state, terms: state.terms.map((item) => (item.id === termId ? term : item)) });
      publish(term, "updated");
      return { term };
    },

    remove(termId) {
      require();
      const term = find(termId);
      writable(term.rootLineId);
      const state = ctx.state();
      ctx.commit({ ...state, terms: state.terms.filter((item) => item.id !== termId) });
      publish(term, "deleted");
    },

    search(query) {
      require();
      const limit = query.limit ?? SEARCH_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) throw new TangentError(400, "limit must be 1–100", "invalid_input", { field: "limit" });
      const offset = query.cursor ? Number(query.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0) throw new TangentError(400, "the cursor is not valid", "invalid_input", { field: "cursor" });
      const ranked = rankTerms(ctx.state().terms.filter((term) => !isArchived(term.rootLineId)), query.q ?? "");
      const page = ranked.slice(offset, offset + limit);
      const titleOf = (root: string) => ctx.state().lines.find((line) => line.id === root)?.title ?? "";
      return { terms: page.map((term) => ({ ...term, rootTitle: titleOf(term.rootLineId) })), nextCursor: offset + limit < ranked.length ? String(offset + limit) : "" };
    },
  };
}

/** The terms after lines went: a term saved from one of them stays in its conversation, without a source line (`ON DELETE SET NULL`). */
export function termsWithoutLines(terms: readonly Term[], gone: ReadonlySet<string>): readonly Term[] {
  return terms.some((term) => gone.has(term.sourceLineId)) ? terms.map((term) => (gone.has(term.sourceLineId) ? { ...term, sourceLineId: "", sourceMessageId: "" } : term)) : terms;
}

/** store.RepointTermSources: an aside continued as a branch takes its terms' sources along (its messages keep their ids). */
export function termsRepointed(terms: readonly Term[], from: string, to: string): readonly Term[] {
  return terms.map((term) => (term.sourceLineId === from ? { ...term, sourceLineId: to } : term));
}

/** store.RehomeTerms: the terms saved from a subtree that became its own conversation go with it. */
export function termsRehomed(terms: readonly Term[], moved: ReadonlySet<string>, newRoot: string): readonly Term[] {
  return terms.map((term) => (moved.has(term.sourceLineId) ? { ...term, rootLineId: newRoot } : term));
}

/** An attach (store.DropCollidingTerms, MoveTreeTerms): the source tree's terms move to the target, except the ones the target already has by key. */
export function termsAttached(terms: readonly Term[], from: string, to: string): readonly Term[] {
  const taken = new Set(terms.filter((term) => term.rootLineId === to).map((term) => term.termKey));
  return terms.filter((term) => term.rootLineId !== from || !taken.has(term.termKey)).map((term) => (term.rootLineId === from ? { ...term, rootLineId: to } : term));
}
