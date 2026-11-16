import { Checkbox } from "../components/checkbox";
import { Select } from "../components/select";
import { useUiT } from "../provider";

/** A provider / model the server allows (`/capabilities.models`, B5), or one the host adds. */
export interface BranchModelOption {
  provider: string;
  model: string;
  /** Shown instead of "provider · model". */
  label?: string;
}

const optionValue = (option: BranchModelOption) => `${option.provider}\u0000${option.model}`;
const optionLabel = (option: BranchModelOption) => option.label ?? (option.provider ? `${option.provider}・${option.model}` : option.model);

export interface ModelFieldProps {
  /** The parent line's runner hints; the default choice. */
  parent: BranchModelOption;
  isParentMain: boolean;
  options: readonly BranchModelOption[];
  value: BranchModelOption;
  onValueChange: (option: BranchModelOption) => void;
}

/** Provider and model: a select of the host's allowed options, or the parent's model as plain text. */
export function ModelField({ parent, isParentMain, options, value, onValueChange }: ModelFieldProps) {
  const t = useUiT();
  const same = (option: BranchModelOption) => (isParentMain ? t("branch.modelSameMain", { model: optionLabel(option) }) : t("branch.modelSameParent", { model: optionLabel(option) }));
  const all = [parent, ...options.filter((option) => optionValue(option) !== optionValue(parent))];
  if (all.length < 2) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-tg-sm font-medium text-tg-foreground">{t("branch.modelLabel")}</span>
        <span className="text-tg-sm text-tg-muted">{same(parent)}</span>
      </div>
    );
  }
  const items = all.map((option, index) => ({ value: optionValue(option), label: index === 0 ? same(option) : optionLabel(option) }));
  return (
    <Select
      label={t("branch.modelLabel")}
      options={items}
      value={optionValue(value)}
      onValueChange={(next) => onValueChange(all.find((option) => optionValue(option) === next) ?? parent)}
    />
  );
}

export function LaterField({ count, checked, onCheckedChange }: { count: number; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  const t = useUiT();
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange}>
        {t("branch.includeLater")}
      </Checkbox>
      <span className="pl-6 text-tg-xs text-tg-muted">{t("branch.includeLaterHelp", { count })}</span>
    </div>
  );
}
