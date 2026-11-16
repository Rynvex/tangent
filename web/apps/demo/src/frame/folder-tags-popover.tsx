/**
 * F13 S5 FolderTagsPopover (w360 beside the row or under the header's menu;
 * a bottom sheet on phones): one folder (chips, the last a dashed 新增資料夾
 * that becomes a field) and up to 12 tags (chips, a field with the tenant's
 * tags, the frequent ones to add with one press). Every change saves at once
 * (decision #3: on the server); a failed save puts that change back and says
 * why. Esc or a press outside closes it.
 */
import { FOLDER_MAX_RUNES, knownFolderNames, knownTagCounts, normalizeFolder, TAGS_MAX } from "@tangent/client";
import { BottomSheet, describeError, IconButton, Popover, PopoverContent, useLine, useLineOrganization, useLines, useTangent, useUiT, useUpdateLineOrganization } from "@tangent/react";
import { Folder, FolderPlus, Inbox, Plus, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { useF13ShellT } from "./f13-shell-messages";
import { useViewportWidth } from "./hooks";
import { TagInput } from "./tag-input";

export interface FolderTagsPopoverProps {
  lineId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What it sits against (the list row, or the menu button). */
  anchor: (() => Element | null) | { getBoundingClientRect: () => DOMRect; contextElement?: Element | undefined };
  side?: "right" | "bottom";
}

const PHONE_MAX = 640;

interface Organization {
  folder: string;
  tags: string[];
}
const FREQUENT_SHOWN = 3;

/** A folder choice (a pressed toggle; one is pressed at a time), or with `action` a plain button (新增資料夾, a frequent tag). */
function Pick({ on, icon, children, onClick, dashed = false, action = false }: { on: boolean; icon: ReactNode; children: ReactNode; onClick: () => void; dashed?: boolean; action?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={action ? undefined : on}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-tg-full border px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring pointer-coarse:h-10 [&_svg]:size-3.5",
        dashed ? "border-dashed border-tg-border-strong text-tg-muted hover:bg-tg-accent" : on ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Body({ lineId, onClose, touch }: { lineId: string; onClose: () => void; touch: boolean }) {
  const s = useF13ShellT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const line = useLine(lineId);
  const active = useLines();
  const archived = useLines({ archived: true });
  const organization = useLineOrganization().data;
  const save = useUpdateLineOrganization();
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  // What the user asked for, shown at once and sent one write at a time (the newest wins, nothing is lost
  // between overlapping saves); cleared when the server holds it, or put back when a save fails.
  const [draft, setDraft] = useState<Organization | null>(null);
  const [saving, setSaving] = useState(false);
  const desired = useRef<Organization | null>(null);
  const flushing = useRef(false);
  const lines = [...(active.data?.lines ?? []), ...(archived.data?.lines ?? [])];
  const current = line.data;
  const shown: Organization = draft ?? { folder: current?.folder ?? "", tags: current?.tags ?? [] };
  const { folder, tags } = shown;
  // B18.1: every folder and tag of the tenant (the loaded conversations until GET /lines/organization is read).
  const folders = [...new Set([...knownFolderNames(organization, lines), ...(folder ? [folder] : [])])].sort((a, b) => a.localeCompare(b));
  const known = knownTagCounts(organization, lines);
  const frequent = known.filter((item) => !tags.includes(item.tag)).slice(0, FREQUENT_SHOWN);

  const flush = async () => {
    if (flushing.current) return;
    flushing.current = true;
    setSaving(true);
    try {
      while (desired.current) {
        const sending = desired.current;
        try {
          await save.mutateAsync({ lineId, folder: sending.folder, tags: sending.tags });
        } catch (error) {
          desired.current = null;
          setDraft(null);
          setFailure(s("tags.saveFailed", { reason: describeError(error, t, hostErrorText) }));
          break;
        }
        if (desired.current === sending) {
          desired.current = null;
          setDraft(null);
        }
      }
    } finally {
      flushing.current = false;
      setSaving(false);
    }
  };
  const write = (change: Partial<Organization>) => {
    // Every save sends the whole folder and tag set: never before the line itself is known.
    if (!current) return;
    setFailure(null);
    const next = { ...(desired.current ?? shown), ...change };
    desired.current = next;
    setDraft(next);
    void flush();
  };
  const addFolder = () => {
    const { folder: name, problem } = normalizeFolder(newFolder);
    if (name === "") return setFolderError(s("folder.nameEmpty"));
    if (problem) return setFolderError(problem === "reserved" ? s("folder.nameReserved") : s("folder.nameTooLong", { max: FOLDER_MAX_RUNES }));
    setAdding(false);
    setNewFolder("");
    write({ folder: name });
  };

  if (!current) {
    return (
      <p role="status" className="m-0 text-tg-sm text-tg-muted">
        {t("ui.loading")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-tg-md font-semibold text-tg-foreground-strong">{s("tags.title")}</h2>
          <p className="m-0 truncate text-tg-xs text-tg-muted">{current?.title || t("shell.untitled")}</p>
        </div>
        <IconButton label={s("tags.close")} icon={<X />} size="sm" tooltip={false} onClick={onClose} />
      </header>
      <section aria-labelledby="tg-folder-pick" className="flex flex-col gap-1.5">
        <h3 id="tg-folder-pick" className="m-0 text-tg-sm font-medium text-tg-foreground">
          {s("tags.folder")}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <div role="group" aria-labelledby="tg-folder-pick" className="flex flex-wrap gap-1.5">
            <Pick on={folder === ""} icon={<Inbox aria-hidden />} onClick={() => folder !== "" && write({ folder: "" })}>
              {s("tags.unfiled")}
            </Pick>
            {folders.map((name) => (
              <Pick key={name} on={folder === name} icon={<Folder aria-hidden />} onClick={() => folder !== name && write({ folder: name })}>
                {name}
              </Pick>
            ))}
          </div>
          {!adding && (
            <Pick on={false} dashed action icon={<FolderPlus aria-hidden />} onClick={() => setAdding(true)}>
              {s("tags.newFolder")}
            </Pick>
          )}
        </div>
        {adding && (
          <div className="flex flex-col gap-1">
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={newFolder}
              aria-label={s("tags.newFolderField")}
              placeholder={s("tags.newFolderField")}
              aria-invalid={folderError ? true : undefined}
              onChange={(event) => {
                setNewFolder(event.target.value);
                setFolderError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addFolder();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setAdding(false);
                }
              }}
              className={cx("w-full rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 text-tg-sm text-tg-foreground outline-none focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-11" : "h-9")}
            />
            {folderError && <p className="m-0 text-tg-xs text-tg-destructive">{folderError}</p>}
          </div>
        )}
      </section>
      <TagInput
        label={s("tags.tags")}
        tags={tags}
        known={known}
        touch={touch}
        autoFocus={!touch}
        onChange={(next) => write({ tags: next })}
        aside={
          <span className="text-tg-xs text-tg-muted">
            {saving && <span className="mr-2">{s("tags.saving")}</span>}
            <span className="font-tg-mono">{s("tags.limit", { n: tags.length })}</span>
          </span>
        }
      />
      {frequent.length > 0 && tags.length < TAGS_MAX && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-tg-xs text-tg-muted">{s("tags.common")}</span>
          {frequent.map((item) => (
            <Pick key={item.tag} on={false} action icon={<Plus aria-hidden />} onClick={() => write({ tags: [...tags, item.tag] })}>
              #{item.tag}
            </Pick>
          ))}
        </div>
      )}
      {failure && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2.5 py-2 text-tg-xs text-tg-foreground">
          {failure}
        </p>
      )}
      <p className="m-0 text-tg-xs text-tg-muted">{s("tags.autosave")}</p>
    </div>
  );
}

export default function FolderTagsPopover({ lineId, open, onOpenChange, anchor, side = "right" }: FolderTagsPopoverProps) {
  const s = useF13ShellT();
  const touch = useViewportWidth() < PHONE_MAX;
  const close = () => onOpenChange(false);
  if (touch) {
    return (
      <BottomSheet open={open} onOpenChange={onOpenChange} label={s("tags.title")}>
        <Body lineId={lineId} onClose={close} touch />
      </BottomSheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverContent aria-label={s("tags.title")} side={side} align="start" anchor={anchor} className="w-90 max-w-[calc(100vw-1rem)] gap-3 rounded-tg-lg py-3 pr-3 pl-4">
        <Body lineId={lineId} onClose={close} touch={false} />
      </PopoverContent>
    </Popover>
  );
}
