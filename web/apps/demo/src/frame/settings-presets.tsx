import { Button, PRESSABLE, useCapabilities, useUiT } from "@tangent/react";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { PRESET_KEYS, PRESET_ORDER, isFeaturePreset, matchingPreset, presetEnv, type FeaturePreset } from "./settings-model";

/** How long 「已複製」 stays. */
const COPIED_MS = 2000;

const PILL =
  `${PRESSABLE} h-(--tg-control-height-sm) rounded-full border border-tg-border-strong bg-tg-surface px-3 text-tg-xs text-tg-foreground pointer-coarse:h-11 ` +
  "hover:border-tg-foreground aria-pressed:border-tg-primary aria-pressed:bg-tg-primary-soft aria-pressed:text-tg-primary-text";

export interface FeaturePresetsProps {
  /** The mock's set in use and how to switch it; absent against a server. */
  mock?: { value: string; onChange: (preset: FeaturePreset) => void } | undefined;
}

/** The line a server restarts with, and a copy button (against a server: the page never changes its features). */
function PresetEnv({ preset, current }: { preset: FeaturePreset; current: boolean }) {
  const t = useUiT();
  const id = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const line = presetEnv(preset);
  const done = (state: "copied" | "failed") => {
    setCopy(state);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), COPIED_MS);
  };
  const onCopy = () => {
    if (!navigator.clipboard) return done("failed");
    navigator.clipboard.writeText(line).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-border bg-tg-surface-raised p-2.5">
      <span id={id} className="text-tg-xs font-medium text-tg-foreground">
        {t("settings.presetEnv", { preset: t(PRESET_KEYS[preset]) })}
      </span>
      <div className="flex items-start gap-2">
        <code aria-labelledby={id} className="min-w-0 flex-1 font-tg-mono text-tg-xs break-all text-tg-foreground select-all">
          {line}
        </code>
        <Button size="sm" variant="secondary" onClick={onCopy}>
          {copy === "copied" ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
          {copy === "copied" ? t("settings.presetCopied") : t("settings.presetCopy")}
        </Button>
      </div>
      <span role="status" className="text-tg-xs text-tg-muted">
        {copy === "failed" ? t("settings.presetCopyFailed") : current ? t("settings.presetCurrent") : ""}
      </span>
      <span className="text-tg-xs text-tg-subtle">{t("settings.presetEnvNote")}</span>
    </div>
  );
}

/**
 * The settings' three quick presets (F9 B.4). On the mock a preset switches
 * its features (`?features=`). Against a server it only shows the
 * `TANGENT_FEATURES` line to restart with: features are the host's.
 */
export function FeaturePresets({ mock }: FeaturePresetsProps) {
  const t = useUiT();
  const capabilities = useCapabilities();
  const running = mock ? (isFeaturePreset(mock.value) ? mock.value : null) : matchingPreset(capabilities.data);
  const [shown, setShown] = useState<FeaturePreset | null>(null);
  const pressed = mock ? running : shown;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={t("settings.presets")} className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-tg-xs text-tg-muted">{t("settings.presets")}</span>
        {PRESET_ORDER.map((preset) => (
          <button key={preset} type="button" aria-pressed={pressed === preset} onClick={() => (mock ? mock.onChange(preset) : setShown(preset))} className={PILL}>
            {t(PRESET_KEYS[preset])}
          </button>
        ))}
      </div>
      {mock ? <span className="text-tg-xs text-tg-subtle">{t("settings.presetMock")}</span> : shown && <PresetEnv key={shown} preset={shown} current={shown === running} />}
    </div>
  );
}
