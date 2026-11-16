/**
 * Folders and tags as the conversation list shows them (F13 S1, S5). Since
 * B18.1 the counts and names come from `GET /lines/organization` (every main
 * line of the tenant, whatever page or filter the list shows); the helpers
 * here fall back to the main lines this page has loaded until it is read.
 */
import type { LineOrganization } from "./b18-routes";
import type { LineView } from "./types";

export interface TagCount {
  tag: string;
  count: number;
}

/** Each tag of the lines with how many use it, most used first (ties by name). */
export function tagCounts(lines: readonly LineView[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const line of lines) for (const tag of new Set(line.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Every folder name in use (archived lines' too, so an emptied folder still shows), sorted by name. */
export function folderNames(lines: readonly LineView[], locale?: string): string[] {
  return [...new Set(lines.map((line) => line.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, locale));
}

export interface FolderGroup {
  folder: string;
  lines: LineView[];
}

/** The lines of each folder (in the given order), folders by name; `names` adds folders with no line here. */
export function groupByFolder(lines: readonly LineView[], names: readonly string[] = [], locale?: string): { folders: FolderGroup[]; unfiled: LineView[] } {
  const all = [...new Set([...names, ...folderNames(lines)])].sort((a, b) => a.localeCompare(b, locale));
  return {
    folders: all.map((folder) => ({ folder, lines: lines.filter((line) => line.folder === folder) })),
    unfiled: lines.filter((line) => !line.folder),
  };
}

/** The tag counts to offer: the tenant's (unarchived main lines) once `GET /lines/organization` is read, else the loaded lines'. */
export function knownTagCounts(organization: LineOrganization | undefined, lines: readonly LineView[]): TagCount[] {
  return organization ? organization.tags.map((item) => ({ tag: item.tag, count: item.count })) : tagCounts(lines);
}

/**
 * The folder names to offer: the tenant's (archived-only folders too) with the loaded lines' (a change the counts have not
 * caught up with yet), else the loaded lines' only; sorted by name.
 */
export function knownFolderNames(organization: LineOrganization | undefined, lines: readonly LineView[], locale?: string): string[] {
  const names = [...(organization?.folders.map((item) => item.folder) ?? []), ...folderNames(lines)];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, locale));
}

/** A folder's unarchived main lines across the tenant, else `fallback` (what the page has loaded of it). */
export function folderLineCount(organization: LineOrganization | undefined, folder: string, fallback: number): number {
  return organization?.folders.find((item) => item.folder === folder)?.active ?? fallback;
}

/** A tag's unarchived main lines across the tenant, else `fallback`. */
export function tagLineCount(organization: LineOrganization | undefined, tag: string, fallback: number | null): number | null {
  return organization?.tags.find((item) => item.tag === tag)?.count ?? fallback;
}

/** The `#tag` pills a row shows: at most `max`, and how many more a "+n" stands for. */
export function visibleTags(tags: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: tags.slice(0, max), more: Math.max(0, tags.length - max) };
}
