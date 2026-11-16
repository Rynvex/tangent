/**
 * Settings → Maintenance and About (G2). Maintenance: the settings as a
 * JSON file out and in, the two resets (each asked a second time), and what
 * this page is connected to. About: the project, its version, licence and
 * links.
 */
import { Badge, Button, useLiveState, useReadOnly, useTangent } from "@tangent/react";
import { Download, ExternalLink, Upload } from "lucide-react";
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { modelPrefs } from "./model-prefs";
import { prefsStore } from "./prefs";
import { clearLocalCache, exportSettings, importSettings, localCacheKeys, resetSettings, serializeSettings, settingsFileName, type ClearableStorage, type SettingsStores } from "./prefs-transfer";
import { ConfirmButton, RowNote, SettingRow, SettingsGroup } from "./settings-controls";
import { useSettingsT, type SettingsMessageKey } from "./settings-messages";

export const APP_VERSION = "v0.1.0";
export const REPO_URL = "https://github.com/Rynvex/tangent";

type Notice = { tone: "status" | "alert"; text: string } | null;

function storageOf(kind: "localStorage" | "sessionStorage"): ClearableStorage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

/** Hands the browser a file to save. */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export interface MaintenancePanelProps {
  /** Tests pass their own; the page's stores, file save, storages and reload otherwise. */
  stores?: SettingsStores;
  save?: (name: string, text: string) => void;
  storages?: () => readonly (ClearableStorage | null)[];
  reload?: () => void;
}

const PAGE_STORES: SettingsStores = { prefs: prefsStore, models: modelPrefs };
const pageStorages = () => [storageOf("localStorage"), storageOf("sessionStorage")];

function StatusLine({ notice }: { notice: Notice }) {
  // Always mounted, so the result is announced.
  return (
    <div role={notice?.tone === "alert" ? "alert" : "status"} className={notice ? undefined : "sr-only"}>
      {notice && <RowNote tone={notice.tone === "alert" ? "destructive" : "muted"}>{notice.text}</RowNote>}
    </div>
  );
}

function Connection() {
  const t = useSettingsT();
  const { client } = useTangent();
  const readOnly = useReadOnly();
  const status = useLiveState((state) => state.connection.status);
  const mock = "mock" in client;
  return (
    <SettingsGroup title={t("g2.group.connection")}>
      <SettingRow id="connection" title={t("g2.connection")} description={t("g2.connection.desc")}>
        <span className="font-tg-mono text-tg-xs break-all text-tg-foreground">{mock ? t("g2.connection.mock") : client.baseUrl || "/"}</span>
      </SettingRow>
      <SettingRow id="connectionEvents" title={t("g2.connection.events")} description={t("g2.connection.events.desc")}>
        <Badge tone={status === "open" ? "success" : status === "reconnecting" ? "warning" : "neutral"}>{t(`g2.connection.status.${status}` as SettingsMessageKey)}</Badge>
      </SettingRow>
      <SettingRow id="connectionAccess" title={t("g2.connection.access")} description={t("g2.connection.access.desc")}>
        <Badge tone={readOnly ? "warning" : "neutral"}>{t(readOnly ? "g2.connection.readOnly" : "g2.connection.readWrite")}</Badge>
      </SettingRow>
    </SettingsGroup>
  );
}

export function MaintenancePanel({ stores = PAGE_STORES, save = saveFile, storages = pageStorages, reload = () => window.location.reload() }: MaintenancePanelProps) {
  const t = useSettingsT();
  const fileId = useId();
  const file = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const say = (text: string) => setNotice({ tone: "status", text });
  const fail = (text: string) => setNotice({ tone: "alert", text });

  const onExport = () => {
    const name = settingsFileName();
    save(name, serializeSettings(exportSettings(stores)));
    say(t("g2.exportSettings.done", { name }));
  };
  const onCopy = () => {
    const text = serializeSettings(exportSettings(stores));
    if (!navigator.clipboard) return fail(t("g2.exportSettings.failed"));
    navigator.clipboard.writeText(text).then(
      () => say(t("g2.exportSettings.copied")),
      () => fail(t("g2.exportSettings.failed")),
    );
  };
  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // The same file can be chosen again after a fix.
    event.target.value = "";
    if (!chosen) return;
    chosen.text().then(
      (text) => {
        const result = importSettings(stores, text);
        if (result.ok) return say(t("g2.importSettings.done"));
        fail(t(`g2.importSettings.${result.reason}`, { version: result.version ?? "" }));
      },
      () => fail(t("g2.importSettings.unreadable")),
    );
  };
  const remembered = storages().reduce((count, storage) => count + localCacheKeys(storage).length, 0);
  const onClear = () => {
    for (const storage of storages()) clearLocalCache(storage);
    // The page's stores still hold what was just cleared: start again from what is stored.
    reload();
  };

  return (
    <>
      <StatusLine notice={notice} />
      <SettingsGroup title={t("g2.group.backup")}>
        <SettingRow id="exportSettings" title={t("g2.exportSettings")} description={t("g2.exportSettings.desc")}>
          <Button icon={<Download aria-hidden className="size-3.5" />} onClick={onExport}>
            {t("g2.exportSettings.button")}
          </Button>
          <Button variant="ghost" onClick={onCopy}>
            {t("g2.exportSettings.copy")}
          </Button>
        </SettingRow>
        <SettingRow id="importSettings" title={t("g2.importSettings")} description={t("g2.importSettings.desc")}>
          <input ref={file} id={fileId} type="file" accept="application/json,.json" aria-label={t("g2.importSettings.file")} className="sr-only" tabIndex={-1} onChange={onImport} />
          <Button icon={<Upload aria-hidden className="size-3.5" />} onClick={() => file.current?.click()}>
            {t("g2.importSettings.button")}
          </Button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={t("g2.group.reset")}>
        <SettingRow id="resetPrefs" title={t("g2.resetPrefs")} description={t("g2.resetPrefs.desc")}>
          <ConfirmButton
            label={t("g2.resetPrefs.button")}
            question={t("g2.restoreAsk")}
            confirm={t("g2.restoreYes")}
            cancel={t("g2.restoreNo")}
            onConfirm={() => {
              resetSettings(stores);
              say(t("g2.restored"));
            }}
          />
        </SettingRow>
        <SettingRow id="clearLocal" title={t("g2.clearLocal")} description={t("g2.clearLocal.desc")}>
          {remembered === 0 ? (
            <span className="text-tg-xs text-tg-subtle">{t("g2.clearLocal.none")}</span>
          ) : (
            <ConfirmButton label={t("g2.clearLocal.button")} question={t("g2.clearLocal.ask", { n: remembered })} confirm={t("g2.clearLocal.yes")} cancel={t("g2.restoreNo")} onConfirm={onClear} />
          )}
        </SettingRow>
      </SettingsGroup>
      <Connection />
    </>
  );
}

function AboutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-tg-sm underline underline-offset-2">
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

export function AboutPanel() {
  const t = useSettingsT();
  return (
    <SettingsGroup title={t("g2.about")} note={t("g2.about.tagline")}>
      <SettingRow id="about" title={t("g2.about.version")}>
        <span className="font-tg-mono text-tg-sm text-tg-foreground">{APP_VERSION}</span>
      </SettingRow>
      <SettingRow id="aboutLicense" title={t("g2.about.license")} description={t("g2.about.licenseValue")}>
        <AboutLink href={`${REPO_URL}/blob/main/LICENSE`}>MIT</AboutLink>
      </SettingRow>
      <SettingRow id="aboutLinks" title={t("g2.about.links")}>
        <AboutLink href={REPO_URL}>{t("g2.about.repo")}</AboutLink>
        <AboutLink href={`${REPO_URL}/blob/main/docs/DESIGN.md`}>{t("g2.about.docs")}</AboutLink>
        <AboutLink href={`${REPO_URL}/blob/main/docs/EMBEDDING.md`}>{t("g2.about.embedding")}</AboutLink>
        <AboutLink href={`${REPO_URL}/issues`}>{t("g2.about.issues")}</AboutLink>
      </SettingRow>
    </SettingsGroup>
  );
}
