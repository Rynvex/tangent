/**
 * The first three cards of the decompose panel (F13 S4; ④ is
 * related-card.tsx) and the writes behind each action. Every action reuses an existing mutation: extract (B18), fold
 * (`createFold`, decision #8), milestones, the line's tags, seeds and
 * relations; spinoff opens the host's dialog.
 */
import type { ChapterCutSuggestion, DetourRange, LineView, SeedCandidate } from "@tangent/client";
import { TAGS_MAX } from "@tangent/client";
import { Check, Clock, Flag, FoldVertical, GitBranch, Plus, Scissors, SquareParking } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "../components/checkbox";
import { describeError } from "../conversation/error-text";
import { useUpdateLineOrganization } from "../data/b18-hooks";
import { useAddMilestone, useDeleteMilestone } from "../data/chapter-hooks";
import { useDropSeed } from "../data/p1-hooks";
import { useCreateFold, useDeleteFold } from "../data/p3-hooks";
import { useCreateSeed } from "../data/park-hooks";
import { useF13T } from "../i18n/f13-messages";
import { cx } from "../lib/cx";
import { useTangent, useUiT } from "../provider";
import { CardButton, DecomposeCard, ItemStatus, LinkButton, PENDING, type ItemState } from "./decompose-cards";
import { detourTopic, type DecomposeAbilities } from "./decompose-model";

/** One item's state, and a way to run a write that sets it (busy, then applied or the error). */
export interface ItemStore {
  get: (key: string) => ItemState;
  set: (key: string, state: ItemState) => void;
}

function useFailure() {
  const ui = useUiT();
  const t = useF13T();
  const { hostErrorText } = useTangent();
  return (error: unknown) => t("decompose.failedOne", { reason: describeError(error, ui, hostErrorText) });
}

/** Runs a write for one item: busy, then what it returns, or its error. */
export function useRunner(store: ItemStore) {
  const failure = useFailure();
  return async (key: string, work: () => Promise<Extract<ItemState, { status: "applied" }>>) => {
    store.set(key, { status: "busy" });
    try {
      store.set(key, await work());
    } catch (error) {
      store.set(key, { status: "error", message: failure(error) });
    }
  };
}

/** Takes an item back: a skip at once, an applied write with its undo (a failed undo leaves it applied, saying why). */
export function useUndo(store: ItemStore) {
  const failure = useFailure();
  return (key: string) => {
    const state = store.get(key);
    if (state.status === "skipped") return store.set(key, PENDING);
    if (state.status !== "applied" || !state.undo) return;
    store.set(key, { status: "busy" });
    state.undo().then(
      () => store.set(key, PENDING),
      (error: unknown) => store.set(key, { ...state, error: failure(error) }),
    );
  };
}

export const busy = (state: ItemState) => state.status === "busy";
const done = (state: ItemState) => state.status === "applied" || state.status === "skipped";

// ① Detours ------------------------------------------------------------------------

export interface DetourCardProps {
  number: number;
  lineId: string;
  detours: readonly DetourRange[];
  numbers: ReadonlyMap<string, number>;
  available: (detour: DetourRange) => boolean;
  abilities: DecomposeAbilities;
  store: ItemStore;
  onExtract: (detour: DetourRange) => void;
  onHighlight: (detour: DetourRange | null) => void;
  onNavigate: (lineId: string) => void;
}

export function DetourCard({ number, lineId, detours, numbers, available, abilities, store, onExtract, onHighlight, onNavigate }: DetourCardProps) {
  const t = useF13T();
  const fold = useCreateFold(lineId);
  const unfold = useDeleteFold(lineId);
  const run = useRunner(store);
  const undo = useUndo(store);
  const keyOf = (detour: DetourRange) => `detour:${detour.fromMessageId}`;
  const applied = detours.every((detour) => done(store.get(keyOf(detour))));
  return (
    <DecomposeCard number={number} title={t("decompose.detours")} applied={applied}>
      {detours.map((detour) => {
        const key = keyOf(detour);
        const state = store.get(key);
        const here = available(detour);
        const canAct = abilities.write && here && !done(state) && !busy(state);
        return (
          <div
            key={key}
            className="flex flex-col gap-2"
            onPointerEnter={() => onHighlight(detour)}
            onPointerLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(detour)}
            onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && onHighlight(null)}
          >
            <p className="m-0 text-tg-sm text-tg-foreground">
              {t("decompose.detourRange", { from: numbers.get(detour.fromMessageId) ?? "?", to: numbers.get(detour.toMessageId) ?? "?", n: detour.messageCount, purpose: detourTopic(detour.purpose) })}
            </p>
            {detour.suggestedConclusion && (
              <p className="m-0 flex gap-2 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 text-tg-xs text-tg-foreground">
                <Flag aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-suggestion" />
                <span>{t("decompose.preview", { text: detour.suggestedConclusion })}</span>
              </p>
            )}
            {!here && !done(state) && <p className="m-0 text-tg-xs text-tg-muted">{t("decompose.gone")}</p>}
            {!done(state) && (
              <div className="flex flex-wrap items-center gap-2">
                {abilities.write && (
                  <CardButton primary disabled={!canAct} icon={<Scissors aria-hidden />} onClick={() => onExtract(detour)}>
                    {busy(state) ? t("decompose.applying") : t("decompose.extract")}
                  </CardButton>
                )}
                {abilities.write && abilities.fold && (
                  <CardButton
                    disabled={!canAct}
                    icon={<FoldVertical aria-hidden />}
                    onClick={() =>
                      void run(key, async () => {
                        const made = await fold.mutateAsync({ fromMessageId: detour.fromMessageId, toMessageId: detour.toMessageId, ...(detour.suggestedConclusion ? { summary: detour.suggestedConclusion } : {}) });
                        return { status: "applied", undo: () => unfold.mutateAsync({ foldId: made.fold.id }) };
                      })
                    }
                  >
                    {t("decompose.foldHere")}
                  </CardButton>
                )}
                {abilities.write && (
                  <LinkButton onClick={() => store.set(key, { status: "skipped" })}>{t("decompose.skip")}</LinkButton>
                )}
              </div>
            )}
            <ItemStatus
              state={state}
              appliedText={state.status === "applied" && state.branchLineId ? t("decompose.extracted") : t("decompose.folded")}
              {...(state.status === "skipped" || (state.status === "applied" && state.undo) ? { onUndo: () => undo(key) } : {})}
              extra={
                state.status === "applied" && state.branchLineId ? (
                  <LinkButton icon={<GitBranch aria-hidden />} onClick={() => onNavigate(state.branchLineId!)}>
                    {t("decompose.viewBranch")}
                  </LinkButton>
                ) : undefined
              }
            />
          </div>
        );
      })}
    </DecomposeCard>
  );
}

// ② Chapter breaks ---------------------------------------------------------------------

export function ChaptersCard({ number, rootLineId, lineId, cuts, numbers, firstTitle, abilities, store }: { number: number; rootLineId: string; lineId: string; cuts: readonly ChapterCutSuggestion[]; numbers: ReadonlyMap<string, number>; firstTitle: string; abilities: DecomposeAbilities; store: ItemStore }) {
  const t = useF13T();
  const add = useAddMilestone(rootLineId, lineId);
  const remove = useDeleteMilestone(rootLineId, lineId);
  const failure = useFailure();
  const undo = useUndo(store);
  const state = store.get("chapters");
  // Cuts are added one by one; if one fails, those already made stay applied (with undo) and the reason shows.
  const apply = async () => {
    store.set("chapters", { status: "busy" });
    const made: string[] = [];
    const undoAll = () => Promise.all(made.map((id) => remove.mutateAsync(id)));
    try {
      for (const cut of cuts) made.push((await add.mutateAsync({ messageId: cut.messageId, title: cut.title })).milestone.id);
      store.set("chapters", { status: "applied", undo: undoAll });
    } catch (error) {
      store.set("chapters", made.length > 0 ? { status: "applied", undo: undoAll, error: failure(error) } : { status: "error", message: failure(error) });
    }
  };
  return (
    <DecomposeCard number={number} title={t("decompose.chapters")} applied={state.status === "applied"}>
      {/* F14: a cut at a long pause comes from the history's real times (kept by an import since B19). */}
      {cuts.some((cut) => cut.reason === "time_gap") && (
        <span data-tg-real-time="" className="inline-flex items-center gap-1 self-start rounded-tg-full bg-tg-surface-sunken px-2 py-0.5 text-tg-xs text-tg-muted">
          <Clock aria-hidden className="size-3" />
          {t("decompose.byRealTime")}
        </span>
      )}
      <ol className="m-0 flex list-none flex-col gap-1 p-0 text-tg-xs text-tg-foreground">
        <li>
          <span className="font-semibold">§1</span> <span className="font-tg-mono text-tg-muted">#1</span> {firstTitle}
        </li>
        {cuts.map((cut, index) => (
          <li key={cut.messageId}>
            <span className="font-semibold">§{index + 2}</span> <span className="font-tg-mono text-tg-muted">#{numbers.get(cut.messageId) ?? "?"}</span> {cut.title}
            <span className="text-tg-muted">・{cut.reason === "time_gap" || cut.reason === "topic_shift" ? t(`decompose.reason.${cut.reason}`) : cut.reason}</span>
          </li>
        ))}
      </ol>
      {abilities.write && state.status !== "applied" && (
        <div>
          <CardButton disabled={busy(state)} onClick={() => void apply()}>
            {busy(state) ? t("decompose.applying") : t("decompose.applyChapters", { n: cuts.length })}
          </CardButton>
        </div>
      )}
      <ItemStatus state={state} appliedText={t("decompose.applied")} {...(state.status === "applied" ? { onUndo: () => undo("chapters") } : {})} />
    </DecomposeCard>
  );
}

// ③ Tags and to-dos ---------------------------------------------------------------------

export function TagsSeedsCard({ number, line, tags, seeds, lineId, rootLineId, abilities, store }: { number: number; line: LineView | undefined; tags: readonly string[]; seeds: readonly SeedCandidate[]; lineId: string; rootLineId: string; abilities: DecomposeAbilities; store: ItemStore }) {
  const t = useF13T();
  const organize = useUpdateLineOrganization();
  const createSeed = useCreateSeed(lineId, rootLineId);
  const dropSeed = useDropSeed(rootLineId);
  const run = useRunner(store);
  const undo = useUndo(store);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(seeds.map((seed) => seed.text)));
  const current = line?.tags ?? [];
  const full = current.length >= TAGS_MAX;
  const seedState = store.get("seeds");
  const toggleTag = (tag: string) => {
    if (!line || !abilities.write) return;
    const has = current.includes(tag);
    if (!has && full) return;
    void run(`tag:${tag}`, async () => {
      await organize.mutateAsync({ lineId: line.id, tags: has ? current.filter((item) => item !== tag) : [...current, tag] });
      return { status: "applied" };
    });
  };
  const park = () => {
    const chosen = seeds.filter((seed) => checked.has(seed.text));
    void run("seeds", async () => {
      const made: string[] = [];
      for (const seed of chosen) made.push((await createSeed.mutateAsync({ text: seed.text, anchorMessageId: seed.messageId })).seed.id);
      return { status: "applied", count: made.length, undo: async () => Promise.all(made.map((seedId) => dropSeed.mutateAsync({ seedId }))) };
    });
  };
  const showTags = tags.length > 0 && abilities.tags;
  const showSeeds = seeds.length > 0 && abilities.parking;
  return (
    <DecomposeCard number={number} title={t("decompose.tagsTodo")} applied={seedState.status === "applied" && tags.every((tag) => current.includes(tag))}>
      {showTags && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-tg-xs text-tg-muted">{t("decompose.suggestedTags")}</span>
          {tags.map((tag) => {
            const on = current.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                aria-label={on ? t("decompose.tagAdded", { tag: `#${tag}` }) : t("decompose.addTag", { tag: `#${tag}` })}
                aria-disabled={!abilities.write || (!on && full) || busy(store.get(`tag:${tag}`)) || undefined}
                onClick={() => toggleTag(tag)}
                className={cx(
                  "inline-flex h-6.5 items-center gap-1 rounded-tg-full border px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-disabled:opacity-45 pointer-coarse:h-9",
                  on ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-primary-text" : "border-dashed border-tg-suggestion bg-tg-surface text-tg-foreground hover:bg-tg-accent",
                )}
              >
                {on ? <Check aria-hidden className="size-3" /> : <Plus aria-hidden className="size-3" />}#{tag}
              </button>
            );
          })}
          {full && <span className="text-tg-xs text-tg-muted">{t("decompose.tagsFull")}</span>}
        </div>
      )}
      {showSeeds && (
        <div className="flex flex-col gap-1">
          {seeds.map((seed) => (
            <Checkbox
              key={`${seed.messageId}:${seed.text}`}
              checked={checked.has(seed.text)}
              disabled={!abilities.write || seedState.status === "applied"}
              onCheckedChange={(on) => setChecked((before) => (on ? new Set([...before, seed.text]) : new Set([...before].filter((text) => text !== seed.text))))}
            >
              {seed.text}
            </Checkbox>
          ))}
          {abilities.write && seedState.status !== "applied" && (
            <div>
              <CardButton disabled={checked.size === 0 || busy(seedState)} icon={<SquareParking aria-hidden />} onClick={park}>
                {busy(seedState) ? t("decompose.applying") : t("decompose.parkN", { n: checked.size })}
              </CardButton>
            </div>
          )}
          <ItemStatus state={seedState} appliedText={t("decompose.parked", { n: seedState.status === "applied" ? (seedState.count ?? 0) : 0 })} {...(seedState.status === "applied" ? { onUndo: () => undo("seeds") } : {})} />
        </div>
      )}
    </DecomposeCard>
  );
}

