/**
 * The main line's title, folder and tags of an assembly (S3: the tree's
 * title row; batch's 「改資料夾與標籤」 for every line). The folder select
 * cannot hold "" as a choice, so unfiled is the reserved filter name.
 */
import { FOLDER_UNFILED, type TagCount, type TimelineSession } from "@tangent/client";
import { Select, TextField } from "@tangent/react";
import { cx } from "../cx";
import { TagInput } from "../tag-input";
import { useF14T } from "./f14-messages";

/** The folder select's "new folder" choice (not a name anyone can type: it starts with a control character). */
export const NEW_FOLDER = "\u0000new";

export interface Organize {
  title: string;
  folderChoice: string;
  newFolder: string;
  tags: readonly string[];
}

export const folderOf = (organize: Organize) => (organize.folderChoice === NEW_FOLDER ? organize.newFolder : organize.folderChoice === FOLDER_UNFILED ? "" : organize.folderChoice);

export const EMPTY_ORGANIZE: Organize = { title: "", folderChoice: FOLDER_UNFILED, newFolder: "", tags: [] };

/** B21: the folder the picked conversations came with (a combined export's projectName), when they name exactly one. */
export function sourceFolderOf(sessions: readonly TimelineSession[]): string {
  const named = new Set(sessions.flatMap((session) => (session.conversation.folder?.trim() ? [session.conversation.folder.trim()] : [])));
  return named.size === 1 ? [...named][0]! : "";
}

/** The organize fields with `folder` chosen: one of the tenant's folders, else typed in as a new one. */
export function withFolder(organize: Organize, folder: string, folders: readonly string[]): Organize {
  return folders.includes(folder) ? { ...organize, folderChoice: folder, newFolder: "" } : { ...organize, folderChoice: NEW_FOLDER, newFolder: folder };
}

/** Whether two organize values name the folder the same way (the select and the new-folder field). */
export const sameFolderFields = (a: Organize, b: Organize) => a.folderChoice === b.folderChoice && a.newFolder === b.newFolder;

export interface OrganizeFieldsProps {
  value: Organize;
  onChange: (next: Organize) => void;
  folders: readonly string[];
  known: readonly TagCount[];
  /** The tree and the timeline name their main line; batch keeps every conversation's own title. */
  withTitle: boolean;
  titlePlaceholder: string;
  touch: boolean;
}

export function OrganizeFields({ value, onChange, folders, known, withTitle, titlePlaceholder, touch }: OrganizeFieldsProps) {
  const t = useF14T();
  const set = (change: Partial<Organize>) => onChange({ ...value, ...change });
  return (
    <div className={cx("grid gap-3", !touch && "grid-cols-2")}>
      {withTitle && <TextField label={t("assembly.mainTitle")} value={value.title} placeholder={titlePlaceholder} maxLength={200} onChange={(event) => set({ title: event.target.value })} className="col-span-full" />}
      <div className="flex flex-col gap-1.5">
        <Select
          label={t("assembly.folder")}
          value={value.folderChoice}
          onValueChange={(folderChoice) => set({ folderChoice })}
          options={[{ value: FOLDER_UNFILED, label: t("assembly.folderNone") }, ...folders.filter((name) => name !== FOLDER_UNFILED).map((name) => ({ value: name, label: name })), { value: NEW_FOLDER, label: t("assembly.folderNew") }]}
        />
        {value.folderChoice === NEW_FOLDER && <TextField aria-label={t("assembly.folderNewField")} placeholder={t("assembly.folderNewField")} value={value.newFolder} onChange={(event) => set({ newFolder: event.target.value })} />}
      </div>
      <TagInput label={t("assembly.tags")} tags={value.tags} onChange={(tags) => set({ tags })} known={known} touch={touch} />
    </div>
  );
}
