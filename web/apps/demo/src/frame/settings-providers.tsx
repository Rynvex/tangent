/**
 * Settings → Providers (G2, on G1's catalog): each provider the reference
 * server knows, whether this server can run it (`GET /capabilities`:
 * `ready` / `reason`), what to set up when it cannot, and its models with a
 * favourite and a hide toggle. The toggles write the model preferences
 * (model-prefs.ts) that the message box's model pill, the default-model
 * list and the open-branch form arrange their choices by.
 */
import { modelInfo, type CapabilityModels } from "@tangent/client";
import { Badge, IconButton, Skeleton, useCapabilities } from "@tangent/react";
import { Eye, EyeOff, Star } from "lucide-react";
import { useContext } from "react";
import { cx } from "./cx";
import { modelPrefs, sameModel, useModelPrefs, withFavorite, withHidden, type ModelPrefsStore } from "./model-prefs";
import { HighlightContext, SettingsGroup } from "./settings-controls";
import { useSettingsT, type SettingsMessageKey } from "./settings-messages";

/** The providers the reference server can be set up with, in the order they are shown. */
export const KNOWN_PROVIDERS = ["claude-cli", "codex-cli", "agy-cli", "openai", "anthropic", "fake"] as const;

const isKnown = (provider: string): provider is (typeof KNOWN_PROVIDERS)[number] => (KNOWN_PROVIDERS as readonly string[]).includes(provider);

export interface ProvidersPanelProps {
  /** Tests pass their own store; the page's otherwise. */
  store?: ModelPrefsStore;
}

type ProviderState = "ready" | "notReady" | "unknown" | "disabled";

function stateOf(group: CapabilityModels | undefined): ProviderState {
  if (!group) return "disabled";
  if (group.ready === undefined) return "unknown";
  return group.ready ? "ready" : "notReady";
}

const STATE_TONES = { ready: "success", notReady: "warning", unknown: "neutral", disabled: "neutral" } as const;

function ProviderCard({ provider, group, store }: { provider: string; group: CapabilityModels | undefined; store: ModelPrefsStore }) {
  const t = useSettingsT();
  const capabilities = useCapabilities();
  const prefs = useModelPrefs(store);
  const state = stateOf(group);
  const guide = isKnown(provider) && (state === "disabled" || state === "notReady") ? t(`g2.guide.${provider}` as SettingsMessageKey) : null;
  const models = (group?.models ?? []).map((model) => modelInfo(capabilities.data, provider, model));
  return (
    <section aria-label={provider} data-provider={provider} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <span className="font-tg-mono text-tg-sm font-medium text-tg-foreground-strong">{provider}</span>
        <Badge tone={STATE_TONES[state]}>{t(`g2.providers.${state}`)}</Badge>
        {group && <span className="text-tg-xs text-tg-subtle">{t("g2.providers.models", { n: models.length })}</span>}
        {(group?.reason || guide) && (
          <span className="flex w-full flex-col gap-0.5 text-tg-xs text-tg-muted">
            {group?.reason && <span>{t("g2.providers.reason", { reason: group.reason })}</span>}
            {guide && <span>{guide}</span>}
          </span>
        )}
      </div>
      {models.length > 0 && (
        <ul className="m-0 flex list-none flex-col border-t border-tg-border p-0">
          {models.map((info) => {
            const favorite = prefs.favorites.some((ref) => sameModel(ref, info));
            const hidden = prefs.hidden.some((ref) => sameModel(ref, info));
            return (
              <li key={info.model} data-model={info.model} className="flex min-h-10 items-center gap-2 border-b border-tg-border py-1 pr-2 pl-6 last:border-b-0">
                <span className={cx("min-w-0 flex-1 truncate text-tg-sm", hidden ? "text-tg-subtle line-through" : "text-tg-foreground")}>{info.label}</span>
                {info.label !== info.model && <span className="hidden min-w-0 truncate font-tg-mono text-tg-xs text-tg-subtle sm:inline">{info.model}</span>}
                {info.status === "legacy" && <Badge>{t("g2.providers.legacy")}</Badge>}
                {hidden && <span className="text-tg-xs text-tg-subtle">{t("g2.providers.hiddenNote")}</span>}
                <IconButton
                  size="sm"
                  tooltip={false}
                  pressed={favorite}
                  label={t(favorite ? "g2.providers.unfavorite" : "g2.providers.favorite", { model: info.label })}
                  icon={<Star className={favorite ? "fill-current text-tg-warning" : undefined} />}
                  onClick={() => store.set(withFavorite(prefs, { provider, model: info.model }, !favorite))}
                />
                <IconButton
                  size="sm"
                  tooltip={false}
                  pressed={hidden}
                  label={t(hidden ? "g2.providers.show" : "g2.providers.hide", { model: info.label })}
                  icon={hidden ? <EyeOff /> : <Eye />}
                  onClick={() => store.set(withHidden(prefs, { provider, model: info.model }, !hidden))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The page: one card for the known providers and any other the server lists, in one bordered list. */
export function ProvidersPanel({ store = modelPrefs }: ProvidersPanelProps) {
  const t = useSettingsT();
  const capabilities = useCapabilities();
  const highlighted = useContext(HighlightContext) === "providers";
  const groups = capabilities.data?.models;
  const extra = (groups ?? []).map((group) => group.provider).filter((provider) => !isKnown(provider));
  return (
    <div data-setting="providers" data-highlighted={highlighted || undefined} className="flex flex-col gap-4">
      <SettingsGroup title={t("g2.providers")} note={t("g2.providers.desc")}>
        {capabilities.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : !groups ? (
          // A server that lists no models says nothing about its providers either.
          <p className="m-0 px-4 py-3 text-tg-sm text-tg-muted">{t("g2.providers.noList")}</p>
        ) : (
          [...KNOWN_PROVIDERS, ...extra].map((provider) => <ProviderCard key={provider} provider={provider} group={groups?.find((group) => group.provider === provider)} store={store} />)
        )}
      </SettingsGroup>
      {groups && <p className="m-0 px-1 text-tg-xs text-tg-muted">{t("g2.providers.pickerNote")}</p>}
    </div>
  );
}
