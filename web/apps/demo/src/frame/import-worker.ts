/**
 * Parses an import file off the main thread (B18.1). The file is untrusted
 * text; this worker has no DOM, so the parsers get an HTML parser that only
 * says "needs the DOM" (an HTML export, or Gemini activity JSON with HTML
 * answers) and the page parses that one itself (import-parse.ts).
 */
import { parseImport } from "@tangent/client";
import { IMPORT_NEEDS_DOM, type ImportWorkerReply, type ImportWorkerRequest } from "./import-worker-protocol";

const scope = self as unknown as { onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null; postMessage(message: ImportWorkerReply): void };

scope.onmessage = (event) => {
  const { token, text, fileName, fileModifiedAt = null } = event.data;
  try {
    const result = parseImport(text, {
      fileName,
      fileModifiedAt,
      parseHtml: () => {
        throw new Error(IMPORT_NEEDS_DOM);
      },
    });
    scope.postMessage({ token, kind: "parsed", result });
  } catch (error) {
    if (error instanceof Error && error.message === IMPORT_NEEDS_DOM) scope.postMessage({ token, kind: "needsDom" });
    else scope.postMessage({ token, kind: "failed", message: error instanceof Error ? error.message : String(error) });
  }
};
