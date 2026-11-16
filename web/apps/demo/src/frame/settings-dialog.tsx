/**
 * The Settings page (G2), after T3 Code's: a search and the categories on
 * the left (a row above the content on a narrow screen), `Settings /
 * <category>` and the close button on top, Restore defaults over the
 * content, and each category's settings as cards of rows. Every row writes
 * a store the frame reads (prefs.ts, model-prefs.ts) or calls the server,
 * so nothing here is a switch without an effect. The whole page, its index
 * and its wording load the first time it is opened.
 */
import type { LineView } from "@tangent/client";
import { addEnglish, Dialog, DialogContent, enSettings, useUiT } from "@tangent/react";
import { Archive, Info, Keyboard, MessageSquare, Palette, Search, Server, Settings2, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "./cx";
import { modelPrefs } from "./model-prefs";
import { prefsStore } from "./prefs";
import { resetSettings } from "./prefs-transfer";
import { ArchivePanel } from "./settings-archive";
import { ConfirmButton, HighlightContext } from "./settings-controls";
import { SETTINGS_NAV, categoryTitleKey, searchSettings, type SettingEntry, type SettingsCategory } from "./settings-index";
import { KeybindingsPanel } from "./settings-keybindings";
import { useSettingsT } from "./settings-messages";
import { PrefsPanel } from "./settings-prefs-panel";
import { ProvidersPanel } from "./settings-providers";
import { AboutPanel, MaintenancePanel } from "./settings-system";
import { ThreadsPanel, type MockSet } from "./settings-threads";

// The feature list's and the model section's English comes with this dialog (F8: kept out of the main bundle).
addEnglish(enSettings);

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Embedded: the host decides the theme. */
  embedded: boolean;
  /** `?theme=` / `?lang=` are in the address (they win over the stored choices; the rows say so). */
  themeFromUrl?: boolean;
  langFromUrl?: boolean;
  /** The line on screen: its provider and model. */
  line: LineView | null;
  /** The mock's feature sets (全開 / C1 / 只有核心, or a preset); absent against a server. */
  featureSet?: { value: MockSet; onChange: (set: MockSet) => void };
  /** Shows a conversation (Archive → a title); the host closes the dialog. */
  onOpenConversation?: (lineId: string) => void;
  /** The category shown first. */
  initialCategory?: SettingsCategory;
}

const CATEGORY_ICONS: Readonly<Record<SettingsCategory, LucideIcon>> = {
  general: Settings2,
  appearance: Palette,
  chat: MessageSquare,
  keybindings: Keyboard,
  providers: Server,
  threads: SlidersHorizontal,
  maintenance: Wrench,
  archive: Archive,
  about: Info,
};

/** How long the row a search result jumped to stays lit. */
const HIGHLIGHT_MS = 2400;

const NAV_ITEM =
  "flex h-8 shrink-0 items-center gap-2 rounded-tg-sm px-2.5 text-left text-tg-sm whitespace-nowrap text-tg-foreground hover:bg-tg-accent " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring aria-[current=page]:bg-tg-accent aria-[current=page]:font-medium aria-[current=page]:text-tg-foreground-strong " +
  "pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-tg-muted";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

export function SettingsDialog({ open, onOpenChange, embedded, themeFromUrl = false, langFromUrl = false, line, featureSet, onOpenConversation, initialCategory = "general" }: SettingsDialogProps) {
  const ui = useUiT();
  const t = useSettingsT();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [query, setQuery] = useState("");
  // The row a search result leads to: scrolled to once its page has rendered, lit for a moment.
  const [target, setTarget] = useState<{ id: string; n: number } | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const results = searchSettings(query, t);
  const searching = query.trim() !== "";

  useEffect(() => {
    if (!target) return undefined;
    const row = content.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target.id)}"]`);
    // jsdom has no layout: scrolling is the browser's part.
    row?.scrollIntoView?.({ block: "center" });
    setHighlighted(target.id);
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [target]);

  const show = (next: SettingsCategory) => {
    setCategory(next);
    setRestored(false);
    content.current?.scrollTo?.({ top: 0 });
  };
  const jump = (entry: SettingEntry) => {
    show(entry.category);
    setQuery("");
    setTarget((last) => ({ id: entry.id, n: (last?.n ?? 0) + 1 }));
  };
  // `/` goes to the search from anywhere in the dialog but a text field.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
    event.preventDefault();
    search.current?.focus();
    search.current?.select();
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      jump(results[0]);
    } else if (event.key === "Escape" && query !== "") {
      // Esc first clears the search; a second one closes the dialog.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };
  const categoryName = t(categoryTitleKey(category));
  const context = { embedded, themeFromUrl, langFromUrl };

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && (
        <DialogContent
          title={
            <span className="flex items-center whitespace-pre">
              <span className="text-tg-muted">{ui("settings.title")}</span>
              {/* Part of the name ("Settings / General"), so the two words are never read as one. */}
              <span className="text-tg-subtle">{" / "}</span>
              <span data-tg-settings-category={category}>{categoryName}</span>
            </span>
          }
          width="page"
          padded={false}
          initialFocus={current}
        >
          <div onKeyDown={onKeyDown} className="flex h-full min-h-0 flex-col md:h-[min(44rem,calc(100dvh-8rem))] md:flex-row">
            <div className="flex shrink-0 flex-col gap-2 border-b border-tg-border bg-tg-surface-sunken p-3 md:w-60 md:border-r md:border-b-0">
              <label className="flex h-(--tg-control-height) shrink-0 items-center gap-2 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 text-tg-subtle focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-tg-ring">
                <Search aria-hidden className="size-3.5 shrink-0" />
                <input
                  ref={search}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onSearchKeyDown}
                  aria-label={t("g2.search")}
                  aria-keyshortcuts="/"
                  placeholder={t("g2.search")}
                  className="min-w-0 flex-1 border-0 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle"
                />
                <kbd aria-hidden className="tg-kbd-hint rounded-tg-sm border border-tg-border px-1 font-tg-mono text-[11px] text-tg-muted">
                  /
                </kbd>
              </label>
              {searching ? (
                <section aria-label={t("g2.searchResults")} className="flex min-h-0 flex-col gap-0.5 overflow-auto">
                  <h3 className="m-0 px-2 pt-1 pb-0.5 text-tg-xs font-medium text-tg-subtle">{t("g2.searchResults")}</h3>
                  {results.map((entry) => (
                    <button key={entry.id} type="button" data-result={entry.id} onClick={() => jump(entry)} className="flex flex-col rounded-tg-sm px-2.5 py-1.5 text-left hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring">
                      <span className="text-tg-sm text-tg-foreground">{t(entry.titleKey)}</span>
                      <span className="text-tg-xs text-tg-muted">{t(categoryTitleKey(entry.category))}</span>
                    </button>
                  ))}
                  {/* Announced: the list changes as the query is typed. */}
                  <p role="status" className="m-0 px-2.5 py-1 text-tg-sm text-tg-muted">
                    {results.length === 0 ? t("g2.searchNone", { query: query.trim() }) : ""}
                  </p>
                </section>
              ) : (
                <nav aria-label={t("g2.categories")} className="flex min-h-0 gap-1 overflow-auto md:flex-col md:gap-3">
                  {SETTINGS_NAV.map((group) => (
                    <div key={group.titleKey} role="group" aria-label={t(group.titleKey)} className="flex shrink-0 gap-0.5 md:flex-col">
                      <span aria-hidden className="hidden px-2.5 pb-0.5 text-tg-xs font-medium text-tg-subtle md:block">
                        {t(group.titleKey)}
                      </span>
                      {group.categories.map((item) => {
                        const Icon = CATEGORY_ICONS[item];
                        return (
                          <button key={item} ref={item === category ? current : undefined} type="button" data-category={item} aria-current={item === category ? "page" : undefined} onClick={() => show(item)} className={NAV_ITEM}>
                            <Icon aria-hidden />
                            {t(categoryTitleKey(item))}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </nav>
              )}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-end gap-2 border-b border-tg-border px-5 py-1.5">
                {/* Always mounted, so the reset is announced. */}
                <span role="status" className="mr-auto text-tg-xs text-tg-muted">
                  {restored ? t("g2.restored") : ""}
                </span>
                <ConfirmButton
                  size="sm"
                  label={t("g2.restore")}
                  question={t("g2.restoreAsk")}
                  confirm={t("g2.restoreYes")}
                  cancel={t("g2.restoreNo")}
                  onConfirm={() => {
                    resetSettings({ prefs: prefsStore, models: modelPrefs });
                    setRestored(true);
                  }}
                />
              </div>
              <div ref={content} role="region" aria-label={categoryName} tabIndex={-1} className={cx("flex min-h-0 flex-1 flex-col gap-6 overflow-auto px-5 py-5")}>
                <HighlightContext.Provider value={highlighted}>
                  {(category === "general" || category === "appearance" || category === "chat") && <PrefsPanel category={category} context={context} />}
                  {category === "keybindings" && <KeybindingsPanel />}
                  {category === "providers" && <ProvidersPanel />}
                  {category === "threads" && <ThreadsPanel line={line} featureSet={featureSet} />}
                  {category === "maintenance" && <MaintenancePanel />}
                  {category === "archive" && <ArchivePanel onOpen={onOpenConversation} />}
                  {category === "about" && <AboutPanel />}
                </HighlightContext.Provider>
              </div>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
