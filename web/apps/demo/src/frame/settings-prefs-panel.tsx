/**
 * The General, Appearance and Chat pages (G2): every row is one field of
 * the preferences (prefs.ts), drawn from the settings index — a switch for
 * an on / off field, a segmented control for a choice. Changing one writes
 * the store at once; the frame reads the same store, so it takes effect
 * while the dialog is still open.
 */
import { Button, formatUsd, SegmentedControl, useShortcutsState, useUiT, type MessageKey } from "@tangent/react";
import { useState, type ReactNode } from "react";
import { PREF_CHOICES, prefsStore, usePrefs, type DemoPrefs, type PrefChoiceKey, type PrefsStore } from "./prefs";
import { RowNote, SettingRow, SettingsGroup, Switch } from "./settings-controls";
import { groupsOf, type SettingEntry, type SettingsCategory } from "./settings-index";
import { useSettingsT, type SettingsMessageKey } from "./settings-messages";
import { notificationPermission, notifyReply, requestNotificationPermission, type NotifyPermission } from "./thread-notify-browser";

/** What the page was opened with that a setting has to give way to. */
export interface PrefsPanelContext {
  /** Embedded: the host decides the theme. */
  embedded: boolean;
  /** `?theme=` / `?lang=` in the address win over the stored choice. */
  themeFromUrl: boolean;
  langFromUrl: boolean;
}

export interface PrefsPanelProps {
  category: SettingsCategory;
  context: PrefsPanelContext;
  /** Tests pass their own store; the page's otherwise. */
  store?: PrefsStore;
}

/** The older wording of the theme and reading font choices (@tangent/react's `settings.*`). */
const LEGACY_LABELS: Readonly<Record<string, MessageKey>> = {
  "theme.light": "settings.themeLight",
  "theme.dark": "settings.themeDark",
  "theme.system": "settings.themeSystem",
  "readingFont.sans": "settings.readingFontSans",
  "readingFont.serif": "settings.readingFontSerif",
};

/** The browser's word on notifications, and the buttons to ask it and to try one. */
function NotificationStatus({ sound }: { sound: boolean }) {
  const t = useSettingsT();
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RowNote role="status" tone={permission === "denied" ? "warning" : "muted"}>
        {t(`g2.notify.${permission}`)}
      </RowNote>
      {permission === "default" && (
        <Button size="sm" onClick={() => void requestNotificationPermission().then(setPermission)}>
          {t("g2.notify.allow")}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => notifyReply({ title: t("g2.notify.testTitle"), body: t("g2.notify.testBody"), sound, onClick: () => undefined })}>
        {t("g2.notify.test")}
      </Button>
    </div>
  );
}

interface ChoiceRowProps {
  entry: SettingEntry;
  pref: PrefChoiceKey;
  order: readonly (string | number)[];
  context: PrefsPanelContext;
  store: PrefsStore;
}

function ChoiceRow({ entry, pref, order, context, store }: ChoiceRowProps) {
  const t = useSettingsT();
  const ui = useUiT();
  const prefs = usePrefs(store);
  const { apple } = useShortcutsState();
  const mod = apple ? "⌘" : "Ctrl";
  const value = prefs[pref];
  const label = (choice: string | number): string => {
    const legacy = LEGACY_LABELS[`${pref}.${choice}`];
    if (legacy) return ui(legacy);
    if (typeof choice === "number") return `US$${formatUsd(choice)}`;
    return t(`g2.${pref}.${choice}` as SettingsMessageKey, { mod });
  };
  const change = (next: string) => {
    const chosen = order.find((choice) => String(choice) === next);
    if (chosen === undefined) return;
    store.update({ [pref]: chosen } as Partial<DemoPrefs>);
    // Notifications need the browser's leave, and it only asks after a press like this one.
    if (pref === "threadNotifications" && chosen !== "off") void requestNotificationPermission();
  };
  let below: ReactNode = null;
  if (pref === "threadNotifications" && value !== "off") below = <NotificationStatus key={String(value)} sound={value === "sound"} />;
  else if (pref === "theme" && context.themeFromUrl && !context.embedded) below = <RowNote>{t("g2.theme.url")}</RowNote>;
  else if (pref === "language" && context.langFromUrl) below = <RowNote>{t("g2.language.url")}</RowNote>;
  else if (pref === "sendShortcut" && Object.hasOwn(prefs.keybindings, "composer.send")) below = <RowNote tone="warning">{t("g2.sendShortcut.custom", { command: ui("command.composer.send") })}</RowNote>;
  else if (pref === "sendShortcut" && value === "mod_enter") below = <RowNote>{t("g2.sendShortcut.bringBack", { mod, command: ui("command.branch.bringBack") })}</RowNote>;
  const title = t(entry.titleKey);
  return (
    <SettingRow id={entry.id} title={title} description={entry.descKey ? t(entry.descKey) : undefined} below={below}>
      {pref === "theme" && context.embedded ? (
        <span className="text-tg-sm text-tg-muted">{ui("settings.themeHost")}</span>
      ) : (
        <SegmentedControl label={title} mono={pref === "costThreshold"} options={order.map((choice) => ({ value: String(choice), label: label(choice) }))} value={String(value)} onValueChange={change} />
      )}
    </SettingRow>
  );
}

function PrefRow({ entry, context, store }: { entry: SettingEntry; context: PrefsPanelContext; store: PrefsStore }) {
  const t = useSettingsT();
  const prefs = usePrefs(store);
  const { control } = entry;
  if (control.kind === "choice") return <ChoiceRow entry={entry} pref={control.pref} order={control.order ?? PREF_CHOICES[control.pref]} context={context} store={store} />;
  if (control.kind !== "flag") return null;
  const { pref } = control;
  return (
    <SettingRow id={entry.id} title={t(entry.titleKey)} description={entry.descKey ? t(entry.descKey) : undefined}>
      {({ labelId, descriptionId }) => <Switch checked={prefs[pref]} onCheckedChange={(checked) => store.update({ [pref]: checked })} labelId={labelId} descriptionId={descriptionId} />}
    </SettingRow>
  );
}

/** One of the three preference pages: its cards and rows, straight from the settings index. */
export function PrefsPanel({ category, context, store = prefsStore }: PrefsPanelProps) {
  const t = useSettingsT();
  return (
    <>
      {groupsOf(category).map(({ group, entries }) => (
        <SettingsGroup key={group} title={t(group)}>
          {entries.map((entry) => (
            <PrefRow key={entry.id} entry={entry} context={context} store={store} />
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
