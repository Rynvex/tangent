import type { MockFeatureSet } from "@tangent/client/testing";
import type { TangentTheme } from "@tangent/react";
import type { Frame } from "./layout";
import { readUrlState } from "./url-state";

/** A14 states the prototype shows through `?state=`; `normal` follows the real connection. */
export const DEMO_STATES = ["normal", "loading", "reconnecting", "aiError", "readonly", "limit"] as const;
export type DemoState = (typeof DEMO_STATES)[number];

export interface DemoParams {
  /** `gallery`: every package component on one page, for the axe run (e2e). */
  view: "app" | "gallery";
  frame: Frame;
  theme: TangentTheme;
  /** `?theme=` was given: it wins over the stored preference (screenshots, comparisons). */
  themeFromUrl: boolean;
  state: DemoState;
  /** Mock capability set: `all` (prototype), `c1` (before C2: no 待處理), `core` (handoff §9-8), or a settings preset (F9 B.4). */
  features: MockFeatureSet;
  /** `?as=viewer`: a read-only identity (the dev proxy sends the viewer token; the UI hides writing). */
  identity: "operator" | "viewer";
  /** `?line=<id>`: open this conversation (an embedding host shows one conversation). */
  line: string | null;
  /** `?m=<messageId>` (with `line`): bring this message into view on opening (F18 §2.4). */
  message: string | null;
  /** `?focus=1`: open in focus mode (FOCUS_MODE.md §5; screenshots, sharing). */
  focus: boolean;
}

/** `?features=`: the mock's sets and the settings' presets. */
export const MOCK_FEATURE_SETS: readonly MockFeatureSet[] = ["all", "c1", "core", "standard", "research", "learning"];

const THEMES: readonly TangentTheme[] = ["system", "light", "dark", "host"];

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** The prototype's URL parameters: `?frame=app|embed&theme=…&state=…&features=all|core`. */
export function readParams(search: string): DemoParams {
  const params = new URLSearchParams(search);
  const address = readUrlState(search);
  const frame = pick<Frame>(params.get("frame"), ["app", "embed"], "app");
  return {
    view: pick(params.get("view"), ["app", "gallery"], "app"),
    frame,
    // Embedded, Tangent takes the host's theme unless told otherwise.
    theme: pick(params.get("theme"), THEMES, frame === "embed" ? "host" : "system"),
    themeFromUrl: THEMES.includes(params.get("theme") as TangentTheme),
    state: pick(params.get("state"), DEMO_STATES, "normal"),
    features: pick<MockFeatureSet>(params.get("features"), MOCK_FEATURE_SETS, "all"),
    identity: pick(params.get("as"), ["operator", "viewer"], "operator"),
    line: address.line,
    message: address.message,
    focus: params.get("focus") === "1",
  };
}
