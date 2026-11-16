import { useState } from "react";
import { useReadOnly } from "../data";
import { useOptionalCommand } from "../shortcuts/shortcuts-provider";
import { RelationDialog, type RelationStart } from "./relation-dialog";
import { RelationList } from "./relation-list";

export interface RelationsSectionProps {
  rootLineId: string;
  /** Where 新增關聯 starts: the line on screen, named as shown. */
  start: RelationStart;
  onGo: (lineId: string, messageId?: string) => void;
  /** Only this line's relations (focus mode's node panel). */
  lineId?: string;
  /**
   * F19 §4 (the outline): no heading, count and 新增關聯 while the tree has no relation. Adding one stays a command
   * away (the palette's 建立關聯…, registered here), next to a message's 「⋯」 and the map's drag.
   */
  hideWhenEmpty?: boolean;
  className?: string;
}

/** The outline's relations (C3) with their 建立關聯 dialog. */
export function RelationsSection({ rootLineId, start, onGo, lineId, hideWhenEmpty = false, className }: RelationsSectionProps) {
  const [adding, setAdding] = useState(false);
  const readOnly = useReadOnly();
  useOptionalCommand("relation.add", () => setAdding(true), hideWhenEmpty && !readOnly);
  return (
    <>
      <RelationList rootLineId={rootLineId} onGo={onGo} onAdd={() => setAdding(true)} hideWhenEmpty={hideWhenEmpty} {...(lineId !== undefined ? { lineId } : {})} {...(className ? { className } : {})} />
      {adding && <RelationDialog open onOpenChange={setAdding} rootLineId={rootLineId} from={start} />}
    </>
  );
}
