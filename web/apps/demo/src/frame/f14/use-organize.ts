/**
 * B21: an assembly's title, folder and tags, the folder following the one
 * the conversations came with (a combined export's projectName) while the
 * user has not picked one. Moved out of use-assembly.ts in F16.1.
 */
import type { TimelineSession } from "@tangent/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_ORGANIZE, folderOf, sameFolderFields, sourceFolderOf, withFolder, type Organize } from "./organize-fields";

/** The tenant's folders may load after the step opens, so a typed-in folder can become a choice. */
export function useOrganize(sessions: readonly TimelineSession[], folders: readonly string[]) {
  const sourceFolder = useMemo(() => sourceFolderOf(sessions), [sessions]);
  const [organize, setOrganizeState] = useState<Organize>(() => (sourceFolder ? withFolder(EMPTY_ORGANIZE, sourceFolder, folders) : EMPTY_ORGANIZE));
  const [folderTouched, setFolderTouched] = useState(false);
  // The folder this hook put in last: replaced when the picked conversations change (going back to step 1 keeps the step mounted).
  const applied = useRef(sourceFolder);
  useEffect(() => {
    if (folderTouched) return;
    const previous = applied.current;
    applied.current = sourceFolder;
    setOrganizeState((current) => {
      const folder = folderOf(current);
      if (folder !== "" && folder !== previous && folder !== sourceFolder) return current;
      const next = sourceFolder ? withFolder(current, sourceFolder, folders) : { ...current, folderChoice: EMPTY_ORGANIZE.folderChoice, newFolder: "" };
      return sameFolderFields(next, current) ? current : next;
    });
  }, [sourceFolder, folders, folderTouched]);
  const setOrganize = (next: Organize) => {
    if (!sameFolderFields(next, organize)) setFolderTouched(true);
    setOrganizeState(next);
  };
  return { organize, setOrganize };
}
