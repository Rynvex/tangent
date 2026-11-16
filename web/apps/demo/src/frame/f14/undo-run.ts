/**
 * The banner's 復原這次匯入 (f13-frame.ts), loaded when it is pressed: undoAssembly and the rate-limit retry it uses
 * (B21) stay out of the main entry.
 */
import { undoAssembly, type UndoAssemblyResult } from "@tangent/client";

export const undoImportedLines = (deleteLine: Parameters<typeof undoAssembly>[0]["deleteLine"], lineIds: readonly string[]): Promise<UndoAssemblyResult> => undoAssembly({ deleteLine }, lineIds);
