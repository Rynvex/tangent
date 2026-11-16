/**
 * The model pill's menu (G1), loaded the first time the pill is pressed:
 * the server's models (hidden ones left out, favourites first, grouped by
 * provider), the reasoning efforts of the line's model when it takes any,
 * and 「設為新對話的預設」. A model or effort change goes to `onChange`
 * (the pill sends the `PATCH /lines/{id}`: it outlives this menu, which
 * closes on the click).
 */
import { modelInfos, type LineView, type ModelInfo, type UpdateLineInput } from "@tangent/client";
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, useCapabilities } from "@tangent/react";
import { Star } from "lucide-react";
import type { RefObject } from "react";
import { effortName, useModelPillT, type LineModel } from "./model-pill";
import { arrangeModelChoices, sameModel, useModelPrefs, withDefaultEffort, withDefaultModel, type ModelPrefsStore } from "./model-prefs";

const choiceValue = (ref: { provider: string; model: string }) => `${ref.provider}\n${ref.model}`;

/** One provider's (or the favourites') models as radio items under a heading. */
function ModelGroup({ label, infos }: { label: string; infos: readonly ModelInfo[] }) {
  const m = useModelPillT();
  return (
    <>
      <div role="presentation" className="px-2.5 pt-2 pb-1 text-tg-xs font-medium text-tg-subtle">
        {label}
      </div>
      {infos.map((info) => (
        <MenuRadioItem key={choiceValue(info)} value={choiceValue(info)}>
          {info.status === "legacy" ? m("modelPill.legacy", { model: info.label }) : info.label}
          {info.ready === false && <span className="ml-1.5 text-tg-xs text-tg-warning">{m("modelPill.notReadyShort")}</span>}
        </MenuRadioItem>
      ))}
    </>
  );
}

/** The non-favourite models grouped by provider, in the order they come. */
export function groupByProvider(infos: readonly ModelInfo[], favorites: readonly ModelInfo[]): Array<{ provider: string; infos: ModelInfo[] }> {
  const providers = [...new Set(infos.filter((info) => !favorites.includes(info)).map((info) => info.provider))];
  return providers.map((provider) => ({ provider, infos: infos.filter((info) => info.provider === provider && !favorites.includes(info)) }));
}

export interface ModelPillMenuProps {
  line: LineView;
  current: LineModel;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onChange: (input: UpdateLineInput) => void;
  store: ModelPrefsStore;
}

export default function ModelPillMenu({ line, current, anchor, onClose, onChange: change, store }: ModelPillMenuProps) {
  const m = useModelPillT();
  const capabilities = useCapabilities();
  const prefs = useModelPrefs(store);
  const arranged = arrangeModelChoices(modelInfos(capabilities.data) ?? [], prefs, line);
  const hasModel = Boolean(line.provider && line.model);
  // A model the server no longer lists still shows, so the radio says what the line uses (skip when using the server default).
  const infos = !hasModel || arranged.some((info) => sameModel(info, line)) ? arranged : [current.info, ...arranged];
  const favorites = infos.filter((info) => prefs.favorites.some((ref) => sameModel(ref, info)));
  const { info, effort, ownEffort } = current;
  const isDefault = hasModel && sameModel(prefs.defaultModel, line) && (prefs.defaultEffort ?? "") === (effort ?? "");
  return (
    <Menu open modal={false} onOpenChange={(open) => !open && onClose()}>
      <MenuContent side="top" anchor={anchor} finalFocus={anchor} className="max-h-[60vh] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto">
        <MenuRadioGroup
          label={m("modelPill.models")}
          value={choiceValue(line)}
          onValueChange={(value: string) => {
            const [provider = "", model = ""] = value.split("\n");
            if (provider !== line.provider || model !== line.model) change({ provider, model });
          }}
        >
          {favorites.length > 0 && <ModelGroup label={m("modelPill.favorites")} infos={favorites} />}
          {groupByProvider(infos, favorites).map((group) => (
            <ModelGroup key={group.provider} label={group.provider} infos={group.infos} />
          ))}
        </MenuRadioGroup>
        {info.effortLevels.length > 0 && (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              label={m("modelPill.effort")}
              value={info.effortLevels.includes(ownEffort) ? ownEffort : ""}
              onValueChange={(value: string) => {
                if (value !== ownEffort) change({ reasoningEffort: value });
              }}
            >
              <MenuRadioItem value="">{m("modelPill.effortDefault")}</MenuRadioItem>
              {info.effortLevels.map((level) => (
                <MenuRadioItem key={level} value={level}>
                  {effortName(m, level)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Star aria-hidden className={isDefault ? "fill-current" : undefined} />}
          disabled={!hasModel || isDefault}
          onSelect={() => {
            if (hasModel) store.set(withDefaultEffort(withDefaultModel(prefs, { provider: line.provider, model: line.model }), effort));
          }}
        >
          {isDefault ? m("modelPill.isDefault") : m("modelPill.makeDefault")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
