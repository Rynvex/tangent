/**
 * Parsing an import file without freezing the page (B18.1). A file of
 * IMPORT_WORKER_MIN_BYTES or more is parsed in a module worker
 * (import-worker.ts, a chunk of its own); a smaller one, or when no worker
 * can start (no `Worker`, tests, a failed start or load), is parsed here with
 * `parseImport`. What needs the DOM (an HTML export, or Gemini activity JSON
 * with HTML answers: workers have no DOMParser) comes back from the worker
 * and is parsed here too. One parse at a time: a newer one, or `dispose`,
 * ends the older (its worker is terminated and its promise rejects with
 * ImportParseSuperseded, which callers ignore).
 */
import { parseImport, type ImportParseResult } from "@tangent/client";
import type { ImportWorkerReply, ImportWorkerRequest } from "./import-worker-protocol";

export type { ImportWorkerReply, ImportWorkerRequest } from "./import-worker-protocol";

/** Files at least this big go to the worker. */
export const IMPORT_WORKER_MIN_BYTES = 1024 * 1024;

/** A parse ended by a newer one or by `dispose`. */
export class ImportParseSuperseded extends Error {
  constructor() {
    super("a newer file replaced this one");
    this.name = "ImportParseSuperseded";
  }
}

/** What the parser needs of a worker (a `Worker`, or a test's stand-in). */
export interface ImportWorkerLike {
  onmessage: ((event: MessageEvent<ImportWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: ImportWorkerRequest): void;
  terminate(): void;
}

export interface ImportParserOptions {
  /** Starts a worker; throwing (or `null`) parses on the main thread. */
  makeWorker?: () => ImportWorkerLike | null;
  minBytes?: number;
}

/** The demo's worker: a module worker Vite builds as its own chunk; none where `Worker` is missing or under tests. */
function defaultWorker(): ImportWorkerLike | null {
  if (typeof Worker === "undefined" || import.meta.env.MODE === "test") return null;
  return new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module", name: "tangent-import" }) as unknown as ImportWorkerLike;
}

export interface ImportParser {
  /** `size` is the file's size in bytes (it picks the worker); F14: `fileModifiedAt` dates conversations that have no date. */
  parse(text: string, fileName: string, size: number, fileModifiedAt?: string | null): Promise<ImportParseResult>;
  /** Ends the parse in progress (the dialog closed). */
  dispose(): void;
}

export function createImportParser({ makeWorker = defaultWorker, minBytes = IMPORT_WORKER_MIN_BYTES }: ImportParserOptions = {}): ImportParser {
  let token = 0;
  let running: { worker: ImportWorkerLike | null; reject: (error: Error) => void } | null = null;

  const end = () => {
    running?.worker?.terminate();
    running?.reject(new ImportParseSuperseded());
    running = null;
  };
  const here = (text: string, fileName: string, fileModifiedAt: string | null) => parseImport(text, { fileName, fileModifiedAt });

  return {
    async parse(text, fileName, size, fileModifiedAt = null) {
      end();
      const mine = (token += 1);
      if (size < minBytes) return here(text, fileName, fileModifiedAt);
      let worker: ImportWorkerLike | null = null;
      try {
        worker = makeWorker();
      } catch {
        worker = null;
      }
      if (!worker) return here(text, fileName, fileModifiedAt);
      const started = worker;
      return new Promise<ImportParseResult>((resolve, reject) => {
        running = { worker: started, reject };
        const settle = (finish: () => void) => {
          if (mine !== token) return;
          started.terminate();
          running = null;
          try {
            finish();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        started.onmessage = (event) => {
          const reply = event.data;
          if (reply.token !== mine) return;
          if (reply.kind === "parsed") settle(() => resolve(reply.result));
          else if (reply.kind === "needsDom") settle(() => resolve(here(text, fileName, fileModifiedAt)));
          else settle(() => reject(new Error(reply.message)));
        };
        // The worker could not load, crashed or sent what cannot be read: the page parses it (the slow way, but it parses).
        const onThePage = () => settle(() => resolve(here(text, fileName, fileModifiedAt)));
        started.onerror = (event) => {
          event.preventDefault?.();
          onThePage();
        };
        started.onmessageerror = onThePage;
        try {
          started.postMessage({ token: mine, text, fileName, fileModifiedAt });
        } catch {
          onThePage();
        }
      });
    },
    dispose() {
      token += 1;
      end();
    },
  };
}
