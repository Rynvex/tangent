/**
 * Simulated parking lot and suggestion inbox (B8 phase A). Seeds belong to
 * the whole tree; suggestions come from the test-only `suggestion_probe`
 * (a sent message with `[probe:suggest]` proposes one, as the server's fake
 * runner echo does) and from the scenario. Every change publishes its
 * event, then the main line's `line.updated` (the 待處理 count).
 */
import type { CreateBranchInput, CreateBranchResult, CreateNoteInput, NoteWriteResult } from "../api-types";
import { isFeatureOn, type FeatureName } from "../capabilities";
import { TangentError } from "../errors";
import { SEED_OPEN_MAX, SEED_TEXT_MAX } from "../p1";
import type { CreateSeedInput, ExpandSeedInput, InboxListQuery, NoteSeedInput, SeedList, SeedNoteResult, SeedWrite, SuggestionList, SuggestionWrite } from "../p1-routes";
import { BRANCH_PURPOSE_MAX } from "../branch-input";
import type { BranchOrigin, Seed, Suggestion, SuggestionStatus } from "../types";
import { publishLine, type MockContext } from "./mock-context";
import { mockSourceLabel } from "./mock-notes";
import { findLine, messagesOf, newId, rootOf } from "./mock-store";

export interface MockInbox {
  listSeeds(lineId: string, query: InboxListQuery): SeedList;
  createSeed(lineId: string, input: CreateSeedInput): SeedWrite;
  expandSeed(seedId: string, input: ExpandSeedInput): SeedWrite & CreateBranchResult;
  noteSeed(seedId: string, input: NoteSeedInput): SeedNoteResult;
  dropSeed(seedId: string): SeedWrite;
  listSuggestions(lineId: string, query: InboxListQuery): SuggestionList;
  accept(suggestionId: string, body?: Readonly<Record<string, unknown>>): SuggestionWrite;
  dismiss(suggestionId: string): SuggestionWrite;
  /** B17: every open suggestion of the tree, in one go (newest first); one `line.updated` after all of them. */
  dismissAll(lineId: string): SuggestionList;
  /** After a finished turn: `[probe:suggest]` in the user's message proposes a suggestion about the line. */
  afterTurn(lineId: string, userContent: string): void;
  /** A branch ended: the open suggestions about it (and the lines under it) expire. */
  expireFor(lineIds: readonly string[]): void;
  /** The open suggestions `match` picks expire (B9: a goal the user wrote ends the open proposals). */
  expireWhere(match: (suggestion: Suggestion) => boolean): void;
  /** A feature proposes a suggestion; skipped while one is open for the same target, or after a permanent dismissal. */
  propose(suggestion: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void;
}

/** What the mock needs from the branch and note simulations. */
export interface MockInboxDeps {
  createBranch(lineId: string, input: CreateBranchInput, origin: BranchOrigin): CreateBranchResult;
  createNote(lineId: string, input: CreateNoteInput): NoteWriteResult;
  /** Runs an accepted suggestion's action (by feature); its result, or null for a feature without one. */
  act(suggestion: Suggestion, body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null;
}

/** Kinds whose dismissal is permanent (the probe's test kind, tree balance's 維持, a fold: B10). */
const PERMANENT_DISMISS = new Set(["probe_permanent", "promote_or_spinoff", "fold"]);

const PROBE = { suggest: "[probe:suggest]", permanent: "[probe:suggest-permanent]" } as const;
const PROBE_REASON = "the reply asked for a probe suggestion";
const NOTE_FROM_SEED_MAX = 400;

const flatten = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => (Array.from(text).length <= max ? text : `${Array.from(text).slice(0, max - 1).join("")}…`);

/** `?status=`: open by default, `all`, or a comma-separated list. */
function statusFilter(query: InboxListQuery): (status: string) => boolean {
  const raw = query.status ?? "open";
  if (raw === "all") return () => true;
  const wanted = new Set(raw.split(",").map((item) => item.trim()));
  return (status) => wanted.has(status);
}

export function createMockInbox(ctx: MockContext, deps: MockInboxDeps): MockInbox {
  const rootFor = (lineId: string) => rootOf(findLine(ctx.state(), lineId));
  /** `anchorLineId` is read each time (B8.1): where the seed's message is now. */
  const withAnchorLine = (seed: Seed): Seed => ({ ...seed, anchorLineId: ctx.state().messages.find((message) => message.id === seed.anchorMessageId)?.lineId ?? "" });

  function require(feature: FeatureName): void {
    if (!isFeatureOn(ctx.scenario.capabilities, feature)) throw new TangentError(404, `the ${feature} feature is off`, "feature_disabled", { feature });
  }

  function saveSeed(seed: Seed): Seed {
    const state = ctx.state();
    const exists = state.seeds.some((item) => item.id === seed.id);
    ctx.commit({ ...state, seeds: exists ? state.seeds.map((item) => (item.id === seed.id ? seed : item)) : [...state.seeds, seed] });
    ctx.bus.publish("seeds.changed", { lineId: seed.rootLineId, rootLineId: seed.rootLineId }, { rootLineId: seed.rootLineId });
    publishLine(ctx, seed.rootLineId);
    return withAnchorLine(seed);
  }

  function openSeed(seedId: string): Seed {
    const seed = ctx.state().seeds.find((item) => item.id === seedId);
    if (!seed) throw new TangentError(404, "seed not found", "seed_not_found");
    if (seed.status !== "open") throw new TangentError(409, "this seed was already expanded, noted or dropped", "seed_not_open");
    return seed;
  }

  /** A done user / assistant chat message of the tree, or "" (domain: the anchor rule of a seed). */
  function anchorFor(lineId: string, root: string, requested: string | undefined): string {
    const inTree = (messageId: string) => ctx.state().messages.find((message) => message.id === messageId && message.kind === "chat" && message.status === "done" && rootFor(message.lineId) === root);
    if (requested) {
      if (!inTree(requested)) throw new TangentError(404, "the anchor message is not in this conversation", "anchor_not_found");
      return requested;
    }
    return messagesOf(ctx.state(), lineId).filter((message) => message.kind === "chat" && message.status === "done").at(-1)?.id ?? "";
  }

  /**
   * Where an expansion hangs (B8 phase B): the anchor's line while it is open;
   * if that line has ended, the nearest open ancestor at the fork message that
   * leads to it; with no anchor left, the main line's newest chat message.
   */
  function expansionPoint(seed: Seed): { lineId: string; anchorMessageId: string } {
    const anchor = ctx.state().messages.find((message) => message.id === seed.anchorMessageId);
    let line = anchor ? findLine(ctx.state(), anchor.lineId) : null;
    let anchorMessageId = anchor?.id ?? "";
    while (line && rootOf(line) === seed.rootLineId && line.conversationBranch && line.conversationBranch.status !== "open") {
      anchorMessageId = line.conversationBranch.anchorMessageId;
      line = findLine(ctx.state(), line.conversationBranch.parentLineId);
    }
    if (line && rootOf(line) === seed.rootLineId) return { lineId: line.id, anchorMessageId };
    const latest = messagesOf(ctx.state(), seed.rootLineId).filter((message) => message.kind === "chat").at(-1);
    if (!latest) throw new TangentError(404, "the main line has no message to hang the branch on", "anchor_not_found");
    return { lineId: seed.rootLineId, anchorMessageId: latest.id };
  }

  function saveSuggestion(suggestion: Suggestion): Suggestion {
    const state = ctx.state();
    const exists = state.suggestions.some((item) => item.id === suggestion.id);
    ctx.commit({ ...state, suggestions: exists ? state.suggestions.map((item) => (item.id === suggestion.id ? suggestion : item)) : [...state.suggestions, suggestion] });
    ctx.bus.publish("suggestion.changed", { lineId: suggestion.lineId, rootLineId: suggestion.rootLineId }, { rootLineId: suggestion.rootLineId, suggestion });
    publishLine(ctx, suggestion.rootLineId);
    return suggestion;
  }

  function openSuggestion(suggestionId: string): Suggestion {
    require("suggestions");
    const suggestion = ctx.state().suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) throw new TangentError(404, "suggestion not found", "suggestion_not_found");
    if (suggestion.status !== "open") throw new TangentError(409, "this suggestion was already accepted, dismissed or expired", "suggestion_not_open");
    return suggestion;
  }

  const decide = (suggestion: Suggestion, status: SuggestionStatus): Suggestion => saveSuggestion({ ...suggestion, status, decidedAt: ctx.now() });

  function propose(raw: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void {
    const blocked = ctx.state().suggestions.some(
      (item) =>
        item.rootLineId === raw.rootLineId &&
        item.feature === raw.feature &&
        item.kind === raw.kind &&
        item.targetKey === raw.targetKey &&
        (item.status === "open" || (item.status === "dismissed" && PERMANENT_DISMISS.has(raw.kind))),
    );
    if (blocked) return;
    const [id, next] = newId(ctx.state(), "suggestion");
    ctx.commit(next);
    saveSuggestion({ ...raw, id, status: "open", createdAt: ctx.now(), decidedAt: null });
  }

  function proposeProbe(lineId: string, kind: string): void {
    propose({ rootLineId: rootFor(lineId), lineId, feature: "suggestion_probe", kind, targetKey: `line:${lineId}`, payload: { reason: PROBE_REASON } });
  }

  /** Marks it accepted first (the server's mark runs before the action's own hooks), then acts; a refused action leaves it open. */
  function accept(suggestionId: string, body: Readonly<Record<string, unknown>>): SuggestionWrite {
    const suggestion = openSuggestion(suggestionId);
    const accepted = decide(suggestion, "accepted");
    try {
      const result = deps.act(accepted, body);
      return { suggestion: ctx.state().suggestions.find((item) => item.id === suggestionId) ?? accepted, result: (result ?? { accepted: true }) as SuggestionWrite["result"] & object };
    } catch (error) {
      saveSuggestion(suggestion);
      throw error;
    }
  }

  function expireWhere(match: (suggestion: Suggestion) => boolean): void {
    for (const suggestion of ctx.state().suggestions.filter((item) => item.status === "open" && match(item))) {
      saveSuggestion({ ...suggestion, status: "expired", decidedAt: ctx.now() });
    }
  }

  const newestFirst = <T extends { createdAt: string }>(items: readonly T[]) => items.map((item, index) => ({ item, index })).sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || b.index - a.index).map(({ item }) => item);

  return {
    listSeeds(lineId, query) {
      require("parking");
      const root = rootFor(lineId);
      const keep = statusFilter(query);
      return { rootLineId: root, seeds: newestFirst(ctx.state().seeds.filter((seed) => seed.rootLineId === root && keep(seed.status))).map(withAnchorLine), limits: { maxOpen: SEED_OPEN_MAX, maxRunes: SEED_TEXT_MAX } };
    },

    createSeed(lineId, input) {
      require("parking");
      const line = findLine(ctx.state(), lineId);
      const root = rootOf(line);
      if (findLine(ctx.state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
      const text = flatten(input.text ?? "");
      if (text === "") throw new TangentError(400, "the seed's text is empty", "invalid_input");
      if (Array.from(text).length > SEED_TEXT_MAX) throw new TangentError(422, "the text is too long", "too_long", { field: "text", max: SEED_TEXT_MAX });
      if (ctx.state().seeds.filter((seed) => seed.rootLineId === root && seed.status === "open").length >= SEED_OPEN_MAX) {
        throw new TangentError(409, "the parking lot is full", "seed_limit", { limit: SEED_OPEN_MAX });
      }
      const anchorMessageId = anchorFor(lineId, root, input.anchorMessageId);
      const [id, next] = newId(ctx.state(), "seed");
      ctx.commit(next);
      const now = ctx.now();
      const anchor = ctx.state().messages.find((message) => message.id === anchorMessageId);
      const sourceLabel = anchor ? mockSourceLabel(ctx.state(), root, { sourceLineId: anchor.lineId, sourceMessageId: anchor.id }) : "";
      return {
        seed: saveSeed({ id, rootLineId: root, anchorMessageId, anchorLineId: "", sourceLabel, text, status: "open", expandedLineId: "", noteId: "", createdBy: "mock-user", createdAt: now, updatedAt: now }),
      };
    },

    expandSeed(seedId, input) {
      require("parking");
      const seed = openSeed(seedId);
      const point = expansionPoint(seed);
      const created = deps.createBranch(
        point.lineId,
        { anchorMessageId: point.anchorMessageId, purpose: input.purpose ?? cut(seed.text, BRANCH_PURPOSE_MAX), kind: input.kind ?? "investigate", ...(input.confirmDeeper ? { confirmDeeper: true } : {}) },
        "seed",
      );
      return { ...created, seed: saveSeed({ ...seed, status: "expanded", expandedLineId: created.line.id, updatedAt: ctx.now() }) };
    },

    noteSeed(seedId, input) {
      require("parking");
      require("notes");
      const seed = openSeed(seedId);
      const source = ctx.state().messages.some((message) => message.id === seed.anchorMessageId) ? { sourceMessageId: seed.anchorMessageId } : {};
      const written = deps.createNote(seed.rootLineId, { section: input.section ?? "to_confirm", text: cut(seed.text, NOTE_FROM_SEED_MAX), ...source });
      return { note: written.note, revision: written.revision, rootLineId: written.rootLineId, seed: saveSeed({ ...seed, status: "noted", noteId: written.note.id, updatedAt: ctx.now() }) };
    },

    dropSeed(seedId) {
      require("parking");
      return { seed: saveSeed({ ...openSeed(seedId), status: "dropped", updatedAt: ctx.now() }) };
    },

    listSuggestions(lineId, query) {
      require("suggestions");
      const root = rootFor(lineId);
      const keep = statusFilter(query);
      return { rootLineId: root, suggestions: newestFirst(ctx.state().suggestions.filter((item) => item.rootLineId === root && keep(item.status))) };
    },

    accept: (suggestionId, body = {}) => accept(suggestionId, body),
    dismiss: (suggestionId) => ({ suggestion: decide(openSuggestion(suggestionId), "dismissed") }),

    dismissAll(lineId) {
      require("suggestions");
      const root = rootFor(lineId);
      const decidedAt = ctx.now();
      const open = newestFirst(ctx.state().suggestions.filter((item) => item.rootLineId === root && item.status === "open"));
      if (open.length === 0) return { rootLineId: root, suggestions: [] };
      const dismissed = open.map((item): Suggestion => ({ ...item, status: "dismissed", decidedAt }));
      const byId = new Map(dismissed.map((item) => [item.id, item]));
      const state = ctx.state();
      ctx.commit({ ...state, suggestions: state.suggestions.map((item) => byId.get(item.id) ?? item) });
      // One suggestion.changed each, then the main line's line.updated (openSuggestions 0), as the server publishes after its one transaction.
      for (const suggestion of dismissed) ctx.bus.publish("suggestion.changed", { lineId: suggestion.lineId, rootLineId: root }, { rootLineId: root, suggestion });
      publishLine(ctx, root);
      return { rootLineId: root, suggestions: dismissed };
    },
    propose,

    afterTurn(lineId, userContent) {
      if (!isFeatureOn(ctx.scenario.capabilities, "suggestions")) return;
      if (userContent.includes(PROBE.permanent)) proposeProbe(lineId, "probe_permanent");
      else if (userContent.includes(PROBE.suggest)) proposeProbe(lineId, "probe");
    },

    expireFor(lineIds) {
      const gone = new Set(lineIds);
      expireWhere((item) => gone.has(item.lineId));
    },

    expireWhere,
  };
}
