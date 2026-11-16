/**
 * Where the frame shows F13's parts (useF13Frame's state): the decompose
 * panel, the banner after an import and the import dialog. Each is a lazy
 * chunk (f13-frame.ts); these wrappers only decide when it mounts.
 */
import type { ExtractBranchResult } from "@tangent/client";
import { LazyRegion } from "@tangent/react";
import { DecomposeHost, ImportDialog, ImportedBanner, type F13Frame } from "./f13-frame";

export interface DecomposeSlotProps {
  frame: F13Frame;
  lineId: string | null;
  variant: "side" | "sheet";
  /** The failure box's class when the panel floats (the sheet). */
  floatingClassName: string;
  navigate: (lineId: string, messageId?: string) => void;
  onSpinoff: (lineId: string, atMessageId: string) => void;
}

/** The decompose panel for the line on screen, while it is open there. */
export function DecomposeSlot({ frame, lineId, variant, floatingClassName, navigate, onSpinoff }: DecomposeSlotProps) {
  if (!frame.decomposeShown || !lineId) return null;
  return (
    <LazyRegion className={variant === "side" ? "h-full" : floatingClassName}>
      <DecomposeHost
        lineId={lineId}
        variant={variant}
        onClose={frame.closeDecompose}
        onHighlight={frame.setHighlight}
        navigate={navigate}
        onSpinoff={onSpinoff}
        onExtracted={(result: ExtractBranchResult) => navigate(result.sourceLineId, result.marker.id)}
      />
    </LazyRegion>
  );
}

/** 已匯入 N 則訊息… on the conversation an import just made. */
export function ImportedSlot({ frame, narrow }: { frame: F13Frame; narrow: boolean }) {
  const here = frame.importedHere;
  if (!here) return null;
  return (
    <LazyRegion>
      <ImportedBanner
        lineId={here.lineId}
        messageCount={here.count}
        assembled={here.assembled}
        panelOpen={frame.decomposeShown}
        narrow={narrow}
        onOpen={() => frame.openDecompose(here.lineId)}
        onClose={frame.dismissImported}
        {...(frame.importUndo ? { onUndo: frame.importUndo.run, undoLabel: frame.importUndo.label } : {})}
      />
    </LazyRegion>
  );
}

/** The import dialog, mounted while it is open. */
export function ImportSlot({ frame, floatingClassName }: { frame: F13Frame; floatingClassName: string }) {
  if (!frame.importOpen) return null;
  return (
    <LazyRegion className={floatingClassName}>
      <ImportDialog open onOpenChange={frame.setImportOpen} onImported={frame.onImported} />
    </LazyRegion>
  );
}
