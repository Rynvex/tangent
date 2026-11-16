/**
 * F17 step 2's mind map workspace (decision #3): the canvas (flex) and the
 * node inspector, 460 wide on the right; full width folds the inspector away
 * (decision #4) until a node is chosen. On a phone the inspector is a panel
 * under the canvas and nothing is dragged (decision #7). It works on the
 * assembly as it is: before an analysis (whole conversations, in any mode)
 * and after one (rounds, #n).
 */
import { useRef, type ReactNode } from "react";
import type { AiTreeView } from "./use-ai-tree";
import { MindMapCanvas } from "./mindmap-canvas";
import { MindMapInspector } from "./mindmap-inspector";
import { folderOf } from "./organize-fields";
import type { Assembly } from "./use-assembly";
import { useMindMap } from "./use-mindmap";

export interface MindMapWorkspaceProps {
  assembly: Assembly;
  view: AiTreeView | null;
  touch: boolean;
  full: boolean;
  onFull: (full: boolean) => void;
  /** The main line's settings (mode, notices, title, folder, tags), shown as the root's details. */
  mainLine: ReactNode;
}

export function MindMapWorkspace({ assembly, view, touch, full, onFull, mainLine }: MindMapWorkspaceProps) {
  const map = useMindMap({ assembly, view, touch });
  const heading = useRef<HTMLHeadingElement>(null);
  const firstChapter = map.model.nodes.find((node) => node.role === "chapter");
  const root = { title: assembly.organize.title.trim() || firstChapter?.title || "", folder: folderOf(assembly.organize), tags: assembly.organize.tags };
  const pick = (key: string, open: boolean, browse = false) => {
    map.select(key);
    // Choosing a node shows its details (full width gives way, decision #4); walking the tree with arrows does not.
    if (full && !browse) onFull(false);
    if (open) requestAnimationFrame(() => heading.current?.focus());
  };
  const showInspector = touch || !full;
  return (
    <div data-tg-mindmap-workspace="" className={touch ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1 border-t border-tg-border"}>
      <MindMapCanvas map={map} touch={touch} full={full && !touch} root={root} onPick={pick} />
      {showInspector && <MindMapInspector map={map} assembly={assembly} view={view} touch={touch} heading={heading} root={root} mainLine={mainLine} />}
    </div>
  );
}
