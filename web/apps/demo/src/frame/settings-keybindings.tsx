/**
 * Settings → Keybindings (G2): every command with its default keys and the
 * keys it has now. Pressing a command's keys records new ones (Esc cancels,
 * keys another command has are refused and named); Reset gives one command
 * its default back. The overrides are kept in the preferences and reach
 * ShortcutsProvider's `bindings`, so they work as soon as they are set.
 */
import { Button, formatKeys, Kbd, useShortcutsState, useUiT, type CommandDef } from "@tangent/react";
import { RotateCcw, Search } from "lucide-react";
import { useContext, useId, useState, type KeyboardEvent } from "react";
import { cx } from "./cx";
import { useShellT } from "./f8-shell-messages";
import { conflictOf, recordKey, withBinding } from "./keybinding-record";
import { bindingOverrides, prefsStore, usePrefs, type PrefsStore } from "./prefs";
import { HighlightContext, RowNote, SettingsGroup } from "./settings-controls";
import { useSettingsT } from "./settings-messages";
import { commandGroup, GROUP_TITLE_KEYS, SHORTCUT_GROUPS } from "./shortcut-groups";

export interface KeybindingsPanelProps {
  /** Tests pass their own store; the page's otherwise. */
  store?: PrefsStore;
}

function Keys({ keys, apple }: { keys: string | null; apple: boolean }) {
  const t = useSettingsT();
  if (!keys) return <span className="text-tg-xs text-tg-subtle">{t("g2.keys.none")}</span>;
  return (
    <span className="inline-flex items-center gap-0.5">
      {formatKeys(keys, apple).map((label, index) => (
        <Kbd key={`${index}-${label}`}>{label}</Kbd>
      ))}
    </span>
  );
}

type Notice = { tone: "status" | "alert"; text: string } | null;

/** The page: a filter, the commands in the shortcut list's four groups, and what the last change did. */
export function KeybindingsPanel({ store = prefsStore }: KeybindingsPanelProps) {
  const t = useSettingsT();
  const ui = useUiT();
  const s = useShellT();
  const prefs = usePrefs(store);
  const { commands, bindings, apple } = useShortcutsState();
  const highlighted = useContext(HighlightContext) === "keybindings";
  const filterId = useId();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A command's keys before the reader's own: its default, or what the send shortcut (Settings → Chat) gives it.
  const base = bindingOverrides({ sendShortcut: prefs.sendShortcut, keybindings: {} });
  const defaultKeys = (command: CommandDef) => (Object.hasOwn(base, command.id) ? (base[command.id] ?? null) : command.keys);
  const text = (keys: string | null) => (keys ? formatKeys(keys, apple).join(apple ? "" : "+") : t("g2.keys.none"));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = commands.filter((command) => {
    const haystack = `${ui(command.titleKey)} ${command.id} ${text(bindings.get(command.id) ?? null)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });

  const save = (command: CommandDef, keys: string | null) => store.update({ keybindings: withBinding(prefs.keybindings, { ...command, keys: defaultKeys(command) }, keys) });

  const onRecordKey = (command: CommandDef, event: KeyboardEvent<HTMLButtonElement>) => {
    // While recording, every key is the recorder's: the dialog must not close on Esc, nor a shortcut fire.
    event.preventDefault();
    event.stopPropagation();
    const result = recordKey(event, apple, command.scope === "composer");
    if (result.kind === "pending") return;
    setRecording(null);
    if (result.kind === "cancel") return setNotice(null);
    if (result.kind === "invalid") return setNotice({ tone: "alert", text: t("g2.keys.invalid") });
    const other = conflictOf(result.keys, command.id, commands, bindings);
    if (other) return setNotice({ tone: "alert", text: t("g2.keys.conflict", { keys: text(result.keys), command: ui(other.titleKey) }) });
    save(command, result.keys);
    setNotice({ tone: "status", text: t("g2.keys.saved", { command: ui(command.titleKey), keys: text(result.keys) }) });
  };

  const reset = (command: CommandDef) => {
    save(command, null);
    setNotice({ tone: "status", text: t("g2.keys.cleared", { command: ui(command.titleKey), keys: text(defaultKeys(command)) }) });
  };

  const changed = Object.keys(prefs.keybindings).length > 0;
  return (
    <div data-setting="keybindings" data-highlighted={highlighted || undefined} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={filterId} className="flex h-(--tg-control-height) min-w-48 flex-1 items-center gap-2 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 text-tg-subtle focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-tg-ring">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            id={filterId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("g2.keys.filter")}
            placeholder={t("g2.keys.filter")}
            className="min-w-0 flex-1 border-0 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle"
          />
        </label>
        <Button size="sm" icon={<RotateCcw aria-hidden className="size-3.5" />} disabled={!changed} onClick={() => {
          store.update({ keybindings: {} });
          setNotice(null);
        }}>
          {t("g2.keys.resetAll")}
        </Button>
      </div>
      <p className="m-0 text-tg-xs text-tg-muted">{t("g2.keys.hint")}</p>
      {/* Always mounted, so what a recording did is announced. */}
      <div role={notice?.tone === "alert" ? "alert" : "status"} className={notice ? undefined : "sr-only"}>
        {notice && <RowNote tone={notice.tone === "alert" ? "destructive" : "muted"}>{notice.text}</RowNote>}
      </div>
      {shown.length === 0 && <p className="m-0 text-tg-sm text-tg-muted">{t("g2.keys.noMatch", { query: query.trim() })}</p>}
      {SHORTCUT_GROUPS.map((group) => {
        const rows = shown.filter((command) => commandGroup(command.id) === group);
        if (rows.length === 0) return null;
        return (
          <SettingsGroup key={group} title={s(GROUP_TITLE_KEYS[group])}>
            {rows.map((command) => {
              const title = ui(command.titleKey);
              const current = bindings.get(command.id) ?? null;
              const fallback = defaultKeys(command);
              const overridden = Object.hasOwn(prefs.keybindings, command.id);
              const isRecording = recording === command.id;
              return (
                <div key={command.id} data-command={command.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                  <span className="flex min-w-40 flex-1 flex-col">
                    <span className="text-tg-sm text-tg-foreground-strong">{title}</span>
                    {overridden && <span className="text-tg-xs text-tg-primary-text">{t("g2.keys.changed")}</span>}
                    {!overridden && !current && fallback && <span className="text-tg-xs text-tg-subtle">{t("g2.keys.lost")}</span>}
                  </span>
                  <span className="flex w-28 shrink-0 flex-col gap-0.5">
                    <span className="text-[11px] text-tg-subtle">{t("g2.keys.default")}</span>
                    <Keys keys={fallback} apple={apple} />
                  </span>
                  <button
                    type="button"
                    aria-label={t("g2.keys.record", { command: title, keys: text(current) })}
                    aria-pressed={isRecording}
                    onClick={() => {
                      setRecording(isRecording ? null : command.id);
                      setNotice(null);
                    }}
                    onKeyDown={isRecording ? (event) => onRecordKey(command, event) : undefined}
                    onBlur={() => isRecording && setRecording(null)}
                    className={cx(
                      "flex min-h-(--tg-control-height) w-44 shrink-0 items-center gap-1.5 rounded-tg-sm border px-2.5 text-left text-tg-xs",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
                      isRecording ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent",
                    )}
                  >
                    {isRecording ? t("g2.keys.recording") : <Keys keys={current} apple={apple} />}
                  </button>
                  <Button size="sm" variant="ghost" aria-label={t("g2.keys.resetLabel", { command: title })} disabled={!overridden} onClick={() => reset(command)}>
                    {t("g2.keys.reset")}
                  </Button>
                </div>
              );
            })}
          </SettingsGroup>
        );
      })}
    </div>
  );
}
