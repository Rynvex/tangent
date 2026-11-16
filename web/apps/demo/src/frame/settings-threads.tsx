/**
 * Settings → Threads (G2): the model of the line on screen, what a new
 * conversation starts with (the default model and reasoning effort of
 * model-prefs.ts, shared with G1's model pill), and Tangent's feature list
 * with each mode. Modes are the host's and only shown (DESIGN §12 F3): the
 * mock can switch its feature sets, a server shows the line to restart with.
 */
import { REASONING_EFFORTS, modelChoices, modelInfo, modelInfos, type AiFeatureMode, type LineView } from "@tangent/client";
import { describeError, SegmentedControl, Select, useCapabilities, useTangent, useUiT, useUpdateLine, type MessageKey } from "@tangent/react";
import { Lock } from "lucide-react";
import { useContext, useId } from "react";
import { cx } from "./cx";
import { useModelPillT } from "./model-pill";
import { arrangeModelChoices, modelPrefs, sameModel, useModelPrefs, withDefaultEffort, withDefaultModel, type ModelPrefsStore } from "./model-prefs";
import { HighlightContext, SettingRow, SettingsGroup } from "./settings-controls";
import { useSettingsT } from "./settings-messages";
import { FEATURE_GROUP_KEYS, PRESET_KEYS, featureGroups, isFeaturePreset, type FeaturePreset, type SettingsFeatureRow } from "./settings-model";
import { FeaturePresets } from "./settings-presets";

export type MockSet = "all" | "c1" | "core" | FeaturePreset;

export interface ThreadsPanelProps {
  /** The line on screen: its provider and model. */
  line: LineView | null;
  /** The mock's feature sets (全開 / C1 / 只有核心, or a preset); absent against a server. */
  featureSet?: { value: MockSet; onChange: (set: MockSet) => void } | undefined;
  /** Tests pass their own store; the page's otherwise. */
  store?: ModelPrefsStore;
}

const MODE_KEYS: Record<AiFeatureMode, MessageKey> = { manual: "settings.modeManual", suggest: "settings.modeSuggest", auto: "settings.modeAuto" };
const ROW = "flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-tg-border px-4 py-2 last:border-b-0";
/** The selects' value for "no choice" (Base UI's select wants a string). */
const NONE = "__default__";
const refKey = (ref: { provider: string; model: string }) => `${ref.provider}/${ref.model}`;
function refOf(value: string): { provider: string; model: string } {
  const [provider = "", ...rest] = value.split("/");
  return { provider, model: rest.join("/") };
}

/** "這個對話": provider and model; the server's list (B5 `/capabilities.models`) makes them changeable. Hidden models are left out, favourites first. */
function ConversationModel({ line, store }: { line: LineView; store: ModelPrefsStore }) {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const prefs = useModelPrefs(store);
  const update = useUpdateLine();
  const highlighted = useContext(HighlightContext) === "conversationModel";
  const listed = modelChoices(capabilities.data);
  const choices = listed ? arrangeModelChoices(listed, prefs, line) : null;
  const current = refKey(line);
  const label = (provider: string, model: string) => t("settings.modelSame", { provider, model: model || t("settings.modelDefault") });
  const options = (choices ?? []).map((choice) => ({ value: refKey(choice), label: label(choice.provider, choice.model) }));
  return (
    <SettingsGroup title={t(line.conversationBranch ? "settings.branch" : "settings.conversation")}>
      <div data-setting="conversationModel" data-highlighted={highlighted || undefined} className={cx("flex flex-col gap-2 px-4 py-3", highlighted && "bg-tg-highlight")}>
        {choices && choices.length > 0 ? (
          <Select
            label={t("settings.model")}
            options={options.some((option) => option.value === current) ? options : [{ value: current, label: label(line.provider, line.model) }, ...options]}
            value={current}
            onValueChange={(value) => update.mutate({ lineId: line.id, input: refOf(value) })}
          />
        ) : (
          <>
            <span className="self-start rounded-tg-sm border border-tg-border px-2.5 py-1.5 text-tg-sm">{label(line.provider, line.model)}</span>
            <span className="text-tg-xs text-tg-subtle">{t("settings.modelUnlisted")}</span>
          </>
        )}
        {update.isSuccess && (
          <span role="status" className="text-tg-xs text-tg-muted">
            {t("settings.modelSaved", { model: update.data.model })}
          </span>
        )}
        {update.error && (
          <span role="alert" className="text-tg-xs text-tg-destructive">
            {t("settings.modelFailed", { reason: describeError(update.error, t, hostErrorText) })}
          </span>
        )}
      </div>
    </SettingsGroup>
  );
}

/** What 新對話 starts with: a model the server lists (or its own default) and a reasoning effort that model takes. */
function NewConversationDefaults({ store }: { store: ModelPrefsStore }) {
  const t = useSettingsT();
  const pill = useModelPillT();
  const capabilities = useCapabilities();
  const prefs = useModelPrefs(store);
  const chosen = prefs.defaultModel ?? null;
  const infos = arrangeModelChoices(modelInfos(capabilities.data) ?? [], prefs, chosen);
  const name = (info: { provider: string; label: string }) => `${info.provider} · ${info.label}`;
  const listed = chosen !== null && infos.some((info) => sameModel(info, chosen));
  const modelOptions = [
    { value: NONE, label: t("g2.defaultModel.server") },
    // A default the server stopped listing stays visible (new conversations fall back to the server's until it is back).
    ...(chosen && !listed ? [{ value: refKey(chosen), label: t("g2.defaultModel.gone", { model: `${chosen.provider} · ${chosen.model}` }) }] : []),
    ...infos.map((info) => ({ value: refKey(info), label: name(info) })),
  ];
  // Without a default model the effort goes to whichever model the server picks, so every level is offered.
  const levels = chosen ? modelInfo(capabilities.data, chosen.provider, chosen.model).effortLevels : REASONING_EFFORTS;
  const effort = prefs.defaultEffort && levels.includes(prefs.defaultEffort) ? prefs.defaultEffort : NONE;
  const effortOptions = [{ value: NONE, label: t("g2.defaultEffort.model") }, ...levels.map((level) => ({ value: level, label: pill(`effort.${level}` as "effort.low") }))];
  return (
    <SettingsGroup title={t("g2.group.newConversations")}>
      <SettingRow id="defaultModel" title={t("g2.defaultModel")} description={t("g2.defaultModel.desc")}>
        <Select aria-label={t("g2.defaultModel")} options={modelOptions} value={chosen ? refKey(chosen) : NONE} onValueChange={(value) => store.set(withDefaultModel(prefs, value === NONE ? null : refOf(value)))} />
      </SettingRow>
      <SettingRow id="defaultEffort" title={t("g2.defaultEffort")} description={t("g2.defaultEffort.desc")}>
        <Select aria-label={t("g2.defaultEffort")} options={effortOptions} value={effort} disabled={levels.length === 0} onValueChange={(value) => store.set(withDefaultEffort(prefs, value === NONE ? null : value))} />
      </SettingRow>
    </SettingsGroup>
  );
}

function FeatureRow({ row }: { row: SettingsFeatureRow }) {
  const t = useUiT();
  const name = row.kind === "core" ? t(row.labelKey) : t(`feature.${row.name}` as MessageKey);
  return (
    <li className={ROW}>
      <span className="flex-1 text-tg-sm">{name}</span>
      {row.kind === "mode" ? (
        <span className="flex items-center gap-1 text-tg-xs text-tg-subtle">
          <Lock aria-hidden className="size-3" />
          {t("settings.featureLocked", { mode: t(MODE_KEYS[row.mode]) })}
        </span>
      ) : (
        <span className="text-tg-xs text-tg-subtle">{t(row.kind === "core" ? "settings.featureCore" : "settings.featureOn")}</span>
      )}
    </li>
  );
}

/** One of the four headings (F9 B.4) and its rows. */
function FeatureGroupList({ title, rows }: { title: string; rows: readonly SettingsFeatureRow[] }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col">
      <h4 id={id} className="m-0 bg-tg-surface-sunken px-4 py-1.5 text-tg-xs font-medium text-tg-foreground">
        {title}
      </h4>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row) => (
          <FeatureRow key={row.kind === "core" ? row.labelKey : row.name} row={row} />
        ))}
      </ul>
    </div>
  );
}

/** The feature matrix: quick presets, the mock's sets, then every enabled feature under four headings with its mode. */
function Features({ featureSet }: Pick<ThreadsPanelProps, "featureSet">) {
  const t = useUiT();
  const g = useSettingsT();
  const capabilities = useCapabilities();
  const highlighted = useContext(HighlightContext) === "features";
  const { groups, othersOff } = featureGroups(capabilities.data);
  return (
    <SettingsGroup title={g("g2.features")} note={g("g2.features.desc")}>
      <div data-setting="features" data-highlighted={highlighted || undefined} className={cx("flex flex-col gap-2 px-4 py-3", highlighted && "bg-tg-highlight")}>
        <FeaturePresets mock={featureSet} />
        {featureSet && (
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex-1 text-tg-sm">{t("settings.featureSet")}</span>
            <SegmentedControl
              label={t("settings.featureSet")}
              options={[
                { value: "all", label: t("settings.featureSetAll") },
                { value: "c1", label: t("settings.featureSetC1") },
                { value: "core", label: t("settings.featureSetCore") },
                // A preset in use shows as the chosen option, so the group keeps its tab stop.
                ...(isFeaturePreset(featureSet.value) ? [{ value: featureSet.value, label: t(PRESET_KEYS[featureSet.value]) }] : []),
              ]}
              value={featureSet.value}
              onValueChange={featureSet.onChange}
            />
          </div>
        )}
        {/* G2: where the modes come from, so someone running their own server knows what to change. */}
        <span className="text-tg-xs text-tg-subtle">{g(featureSet ? "g2.features.mock" : "g2.features.env")}</span>
      </div>
      {groups.map(({ group, rows }) => (
        <FeatureGroupList key={group} title={t(FEATURE_GROUP_KEYS[group])} rows={rows} />
      ))}
      {othersOff && <span className="px-4 py-2 text-tg-xs text-tg-subtle">{t("settings.othersOff")}</span>}
    </SettingsGroup>
  );
}

export function ThreadsPanel({ line, featureSet, store = modelPrefs }: ThreadsPanelProps) {
  return (
    <>
      {line && <ConversationModel line={line} store={store} />}
      <NewConversationDefaults store={store} />
      <Features featureSet={featureSet} />
    </>
  );
}
