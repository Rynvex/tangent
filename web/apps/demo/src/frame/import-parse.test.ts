// @vitest-environment jsdom
import { parseImport } from "@tangent/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImportParser, IMPORT_WORKER_MIN_BYTES, ImportParseSuperseded, type ImportWorkerLike, type ImportWorkerReply, type ImportWorkerRequest } from "./import-parse";

/** B18.1: big import files parse in a worker; small ones, and anything a worker cannot do, on the page. */

const TRANSCRIPT = "User: How do I tune autovacuum?\nAI: Lower the scale factor for big tables.";
const BIG = IMPORT_WORKER_MIN_BYTES;

class FakeWorker implements ImportWorkerLike {
  onmessage: ((event: MessageEvent<ImportWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  sent: ImportWorkerRequest[] = [];
  terminated = false;
  postMessage(message: ImportWorkerRequest): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: Partial<ImportWorkerReply> & { kind: ImportWorkerReply["kind"] }): void {
    this.onmessage?.({ data: { token: this.sent.at(-1)!.token, ...data } } as MessageEvent<ImportWorkerReply>);
  }
}

function withWorkers() {
  const made: FakeWorker[] = [];
  const parser = createImportParser({
    makeWorker: () => {
      const worker = new FakeWorker();
      made.push(worker);
      return worker;
    },
  });
  return { parser, made };
}

describe("createImportParser", () => {
  it("parses a small file on the page, without a worker", async () => {
    const { parser, made } = withWorkers();
    expect(await parser.parse(TRANSCRIPT, "chat.md", 100)).toEqual(parseImport(TRANSCRIPT, { fileName: "chat.md" }));
    expect(made).toHaveLength(0);
  });

  it("sends a big file to a worker and takes its answer, then ends the worker", async () => {
    const { parser, made } = withWorkers();
    const parsing = parser.parse(TRANSCRIPT, "chat.md", BIG, "2026-08-18T09:00:00.000Z");
    // F14: the file's modified time goes along, for conversations without a date of their own.
    expect(made[0]!.sent).toEqual([{ token: expect.any(Number), text: TRANSCRIPT, fileName: "chat.md", fileModifiedAt: "2026-08-18T09:00:00.000Z" }]);
    const result = parseImport(TRANSCRIPT, { fileName: "chat.md" });
    made[0]!.reply({ kind: "parsed", result });
    expect(await parsing).toEqual(result);
    expect(made[0]!.terminated).toBe(true);
  });

  it("parses on the page what needs the DOM, and when the worker cannot start or load", async () => {
    const html = "<html><body><p>User: hi</p><p>AI: hello</p></body></html>";
    const { parser, made } = withWorkers();
    const needsDom = parser.parse(html, "chat.html", BIG);
    made[0]!.reply({ kind: "needsDom" });
    // The page's DOMParser (jsdom here) reads it.
    expect(await needsDom).toEqual(parseImport(html, { fileName: "chat.html" }));
    const crashed = parser.parse(TRANSCRIPT, "chat.md", BIG);
    made[1]!.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
    expect((await crashed).ok).toBe(true);
    const refused = createImportParser({
      makeWorker: () => {
        throw new Error("blocked by the page's policy");
      },
    });
    expect((await refused.parse(TRANSCRIPT, "chat.md", BIG)).ok).toBe(true);
    expect((await createImportParser({ makeWorker: () => null }).parse(TRANSCRIPT, "chat.md", BIG)).ok).toBe(true);
    // An answer that cannot be read, or a request that cannot be sent, also ends on the page.
    const unreadable = parser.parse(TRANSCRIPT, "chat.md", BIG);
    made[2]!.onmessageerror?.({} as MessageEvent);
    expect((await unreadable).ok).toBe(true);
    expect(made[2]!.terminated).toBe(true);
    const unsendable = new FakeWorker();
    unsendable.postMessage = () => {
      throw new Error("DataCloneError");
    };
    expect((await createImportParser({ makeWorker: () => unsendable }).parse(TRANSCRIPT, "chat.md", BIG)).ok).toBe(true);
    expect(unsendable.terminated).toBe(true);
  });

  it("ends an older parse when a newer file comes, and ignores the older worker's late answer", async () => {
    const { parser, made } = withWorkers();
    const first = parser.parse(TRANSCRIPT, "old.md", BIG);
    const second = parser.parse(TRANSCRIPT, "new.md", BIG);
    await expect(first).rejects.toBeInstanceOf(ImportParseSuperseded);
    expect(made[0]!.terminated).toBe(true);
    const late = vi.fn();
    void second.then(late);
    made[0]!.onmessage?.({ data: { token: made[0]!.sent[0]!.token, kind: "parsed", result: { ok: false, error: "empty" } } } as MessageEvent<ImportWorkerReply>);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
    made[1]!.reply({ kind: "parsed", result: parseImport(TRANSCRIPT) });
    expect((await second).ok).toBe(true);
  });

  it("ends the parse when the dialog closes, and reports a worker's failure", async () => {
    const { parser, made } = withWorkers();
    const open = parser.parse(TRANSCRIPT, "chat.md", BIG);
    parser.dispose();
    await expect(open).rejects.toBeInstanceOf(ImportParseSuperseded);
    expect(made[0]!.terminated).toBe(true);
    const failing = parser.parse(TRANSCRIPT, "chat.md", BIG);
    made[1]!.reply({ kind: "failed", message: "out of memory" });
    await expect(failing).rejects.toThrow("out of memory");
  });
});

describe("import-worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("parses without a DOM and says so for what needs one", async () => {
    const posted: ImportWorkerReply[] = [];
    const scope: { onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null; postMessage(message: ImportWorkerReply): void } = {
      onmessage: null,
      postMessage: (message) => posted.push(message),
    };
    vi.stubGlobal("self", scope);
    await import("./import-worker");
    scope.onmessage?.({ data: { token: 1, text: TRANSCRIPT, fileName: "chat.md" } } as MessageEvent<ImportWorkerRequest>);
    scope.onmessage?.({ data: { token: 2, text: "<html><body><p>hi</p></body></html>", fileName: "chat.html" } } as MessageEvent<ImportWorkerRequest>);
    expect(posted).toEqual([
      { token: 1, kind: "parsed", result: parseImport(TRANSCRIPT, { fileName: "chat.md" }) },
      { token: 2, kind: "needsDom" },
    ]);
  });
});
