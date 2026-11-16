/**
 * G1: the composer's model pill and what a new conversation starts with.
 *
 * The pill shows the line's model and reasoning effort and changes them on
 * the spot (`PATCH /lines/{id}`: provider / model, and `reasoningEffort`,
 * which the reference server keeps in the line's `hostMeta`); it can make
 * the choice the default for new conversations (model-prefs.ts). Hidden
 * models are left out and favourites come first. Efforts are offered only
 * for a model the server says takes them, so nothing here is a switch
 * without an effect.
 */
import { modelInfo, type LineView, type ModelInfo, type UpdateLineInput } from "@tangent/client";
import { describeError, LazyRegion, useBundleT, useCapabilities, useCreateLine, useTangent, useUiT, useUpdateLine, type MessageBundle } from "@tangent/react";
import { ChevronDown } from "lucide-react";
import { lazy, useRef, useState } from "react";
import { modelPrefs, newLineInput, type ModelPrefsStore } from "./model-prefs";

const en = {
  "modelPill.label": "Model: {model}",
  "modelPill.labelEffort": "Model: {model}, reasoning effort {effort}",
  "modelPill.models": "Model",
  "modelPill.favorites": "Favourites",
  "modelPill.legacy": "{model} (older)",
  "modelPill.notReady": "{provider}: not available ({reason})",
  "modelPill.notReadyShort": "not available",
  "modelPill.effort": "Reasoning effort",
  "modelPill.effortDefault": "Model default",
  "modelPill.makeDefault": "Use for new conversations",
  "modelPill.isDefault": "Default for new conversations",
  "modelPill.failed": "Not changed: {reason}",
  "modelPill.guide": "This conversation uses {model}",
  "modelPill.guideEffort": "This conversation uses {model} · reasoning effort {effort}",
  "effort.low": "Low",
  "effort.medium": "Medium",
  "effort.high": "High",
  "effort.xhigh": "Extra high",
  "effort.max": "Max",
};

type ModelPillKey = keyof typeof en;

const zhTW: Record<ModelPillKey, string> = {
  "modelPill.label": "模型：{model}",
  "modelPill.labelEffort": "模型：{model}，思考深度 {effort}",
  "modelPill.models": "模型",
  "modelPill.favorites": "常用",
  "modelPill.legacy": "{model}（舊版）",
  "modelPill.notReady": "{provider}：無法使用（{reason}）",
  "modelPill.notReadyShort": "無法使用",
  "modelPill.effort": "思考深度",
  "modelPill.effortDefault": "模型預設",
  "modelPill.makeDefault": "設為新對話的預設",
  "modelPill.isDefault": "已是新對話的預設",
  "modelPill.failed": "沒有變更：{reason}",
  "modelPill.guide": "這個對話使用 {model}",
  "modelPill.guideEffort": "這個對話使用 {model}・思考深度 {effort}",
  "effort.low": "低",
  "effort.medium": "中",
  "effort.high": "高",
  "effort.xhigh": "很高",
  "effort.max": "最高",
};

const ja: Record<ModelPillKey, string> = {
  "modelPill.label": "モデル：{model}",
  "modelPill.labelEffort": "モデル：{model}、推論の深さ {effort}",
  "modelPill.models": "モデル",
  "modelPill.favorites": "お気に入り",
  "modelPill.legacy": "{model}（旧バージョン）",
  "modelPill.notReady": "{provider}：利用不可（{reason}）",
  "modelPill.notReadyShort": "利用不可",
  "modelPill.effort": "推論の深さ",
  "modelPill.effortDefault": "モデル既定",
  "modelPill.makeDefault": "新しい会話の既定にする",
  "modelPill.isDefault": "新しい会話の既定です",
  "modelPill.failed": "変更できませんでした：{reason}",
  "modelPill.guide": "この会話では {model} を使用中",
  "modelPill.guideEffort": "この会話では {model} を使用中・推論の深さ {effort}",
  "effort.low": "低",
  "effort.medium": "中",
  "effort.high": "高",
  "effort.xhigh": "特高",
  "effort.max": "最大",
};

export const MODEL_PILL_MESSAGES: MessageBundle<ModelPillKey> = { en, "zh-TW": zhTW, ja };

/** The pill's strings in the provider's locale. */
export const useModelPillT = () => useBundleT(MODEL_PILL_MESSAGES);

/** The reasoning effort the reference server keeps in a line's hostMeta ("" when none). */
export function hostMetaEffort(line: Pick<LineView, "hostMeta"> | null | undefined): string {
  const meta = line?.hostMeta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return "";
  const effort = meta.reasoningEffort;
  return typeof effort === "string" ? effort : "";
}

/** A line's model and the effort its turns run with: the line's own, else (a branch) its main line's, shown only when the model takes it. */
export interface LineModel {
  info: ModelInfo;
  /** The effort in use (null: the model's own default or none). */
  effort: string | null;
  /** The effort the line itself sets ("" when it inherits or has none): what the pill's radio shows. */
  ownEffort: string;
}

export function useLineModel(line: LineView, rootLine?: LineView | null): LineModel {
  const capabilities = useCapabilities();
  const info = modelInfo(capabilities.data, line.provider, line.model);
  const ownEffort = hostMetaEffort(line);
  const asked = ownEffort || (line.conversationBranch ? hostMetaEffort(rootLine) : "");
  return { info, effort: asked && info.effortLevels.includes(asked) ? asked : null, ownEffort };
}

/** An effort's name in the pill's words (an unknown one as it is). */
export function effortName(t: ReturnType<typeof useModelPillT>, effort: string): string {
  const key = `effort.${effort}`;
  return key in en ? t(key as ModelPillKey) : effort;
}

export interface ModelPillProps {
  line: LineView;
  /** The main line, when `line` is a branch (its effort is the branch's unless the branch sets one). */
  rootLine?: LineView | null;
  /** Told why a change failed. */
  onError?: (message: string) => void;
  /** Tests pass their own store; the page's otherwise. */
  store?: ModelPrefsStore;
}

/** The menu (Base UI's menu is not in the main chunk) loads the first time the pill is pressed. */
const ModelPillMenu = lazy(() => import("./model-pill-menu"));

/**
 * The composer's model pill (G1): the line's model and effort; pressed, its
 * menu (model-pill-menu.tsx). Renders nothing when the server lists no models.
 */
export function ModelPill({ line, rootLine, onError, store = modelPrefs }: ModelPillProps) {
  const t = useUiT();
  const m = useModelPillT();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const update = useUpdateLine();
  const current = useLineModel(line, rootLine);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!capabilities.data?.models?.length) return null;
  const change = (input: UpdateLineInput) =>
    update.mutate({ lineId: line.id, input }, { onError: (error) => onError?.(m("modelPill.failed", { reason: describeError(error, t, hostErrorText) })) });
  const { info, effort } = current;
  const notReady = info.ready === false ? m("modelPill.notReady", { provider: info.provider, reason: info.reason ?? "" }) : undefined;
  // A line without a model runs the server's default.
  const name = info.label || t("settings.modelDefault");
  const label = effort ? m("modelPill.labelEffort", { model: name, effort: effortName(m, effort) }) : m("modelPill.label", { model: name });
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={notReady ?? label}
        onClick={() => setOpen(!open)}
        className="inline-flex h-7 max-w-56 min-w-0 items-center gap-1 rounded-tg-full border border-tg-border px-2.5 text-tg-xs text-tg-muted outline-none hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring aria-expanded:bg-tg-accent"
      >
        {info.ready === false && <span aria-hidden className="size-1.5 shrink-0 rounded-tg-full bg-tg-warning" />}
        <span className="truncate">{name}</span>
        {effort && <span className="shrink-0 text-tg-subtle">· {effortName(m, effort)}</span>}
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      </button>
      {open && (
        <LazyRegion>
          <ModelPillMenu line={line} current={current} anchor={anchor} store={store} onClose={() => setOpen(false)} onChange={change} />
        </LazyRegion>
      )}
    </>
  );
}

/**
 * 新對話 (G1): creates a conversation with the default model and effort
 * of this browser (when the server still lists the model); resolves to the
 * new line.
 */
export function useNewConversation(store: ModelPrefsStore = modelPrefs) {
  const createLine = useCreateLine();
  const capabilities = useCapabilities();
  return {
    create: () => createLine.mutateAsync(newLineInput(store.get(), capabilities.data)),
    mutation: createLine,
  };
}

/** An empty conversation's line about its model and effort (G1); nothing while the server lists no models. */
export function LineModelNote({ line, rootLine }: { line: LineView; rootLine?: LineView | null }) {
  const m = useModelPillT();
  const capabilities = useCapabilities();
  const { info, effort } = useLineModel(line, rootLine);
  if (!capabilities.data?.models || !line.model) return null;
  return (
    <p className="m-0 text-tg-xs text-tg-muted" data-testid="line-model-note">
      {effort ? m("modelPill.guideEffort", { model: info.label, effort: effortName(m, effort) }) : m("modelPill.guide", { model: info.label })}
    </p>
  );
}
