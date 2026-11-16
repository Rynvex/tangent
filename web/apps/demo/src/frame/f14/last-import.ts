/**
 * The last import of this browser session (F14.1): what 復原這次匯入 deletes
 * and where it goes back to, kept in sessionStorage for 10 minutes so the
 * banner can still offer the undo after the toast went or the page reloaded.
 * Storage failing only loses the undo after a reload.
 */

/** How long an import can be undone. */
export const IMPORT_UNDO_MS = 10 * 60_000;

const STORAGE_KEY = "tangent.f14.lastImport";

export interface LastImport {
  lineIds: readonly string[];
  focusLineId: string;
  /** The line on screen before the import (undo goes back there). */
  beforeLineId: string | null;
  messageCount: number;
  assembled: boolean;
  /** `Date.now()` of the import. */
  importedAt: number;
  /** The banner was closed (it does not come back after a reload). */
  dismissed?: boolean;
}

const isLastImport = (value: unknown): value is LastImport => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<LastImport>;
  return (
    Array.isArray(item.lineIds) && item.lineIds.length > 0 && item.lineIds.every((id) => typeof id === "string") &&
    typeof item.focusLineId === "string" && (item.beforeLineId === null || typeof item.beforeLineId === "string") &&
    Number.isInteger(item.messageCount) && (item.messageCount ?? -1) >= 0 && typeof item.assembled === "boolean" &&
    Number.isFinite(item.importedAt) && (item.dismissed === undefined || typeof item.dismissed === "boolean")
  );
};

/** Whether the import can still be undone at `now`. */
export const undoable = (record: LastImport, now: number = Date.now()) => now - record.importedAt < IMPORT_UNDO_MS && now >= record.importedAt;

/** The last import while it can be undone; an expired or unreadable one is forgotten. */
export function readLastImport(now: number = Date.now()): LastImport | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (isLastImport(record) && undoable(record, now)) return record;
    if (raw) window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Unavailable storage: nothing to restore.
  }
  return null;
}

export function rememberLastImport(record: LastImport): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode or full storage: the undo lives as long as this page.
  }
}

export function forgetLastImport(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}
