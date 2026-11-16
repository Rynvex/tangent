/**
 * The import dialog's lower half (F13 S2): which conversation of the file,
 * restoring its other versions as branches, the message preview (switch a
 * role, remove or restore a message), title, folder and tags, and the two
 * import buttons. Everything is checked against the server's limits before
 * it is sent (import-plan.ts); no model is called either way.
 */
import {
  buildImportPlan,
  FOLDER_UNFILED,
  IMPORT_MAX_BRANCH_MESSAGES,
  IMPORT_MAX_BRANCHES,
  IMPORT_MAX_MESSAGES,
  previewLine,
  type ImportConversationResult,
  type ImportRole,
  type ParsedConversation,
  type ParsedImport,
  type TagCount,
} from "@tangent/client";
import { Button, Checkbox, describeError, ErrorAlert, Select, TextField, useImportConversation, useTangent, useUiT } from "@tangent/react";
import { ArrowLeftRight, GitBranch, Sparkles, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "./cx";
import { useF13ImportT } from "./f13-import-messages";
import { TagInput } from "./tag-input";

/** B21: a limit as the texts show it ("2,000"). */
const limitText = (n: number) => n.toLocaleString("en-US");

/** The folder select's "new folder" choice (not a name a user can type: it starts with a control character). */
const NEW_FOLDER = "\u0000new";
const SUGGEST_SCAN = 6;

export interface ImportFormProps {
  parsed: ParsedImport;
  conversation: ParsedConversation;
  folders: readonly string[];
  known: readonly TagCount[];
  touch: boolean;
  onCancel: () => void;
  onImported: (result: ImportConversationResult, decompose: boolean) => void;
}

/** Whether a text mentions a tag (an ASCII tag as a whole word). */
function mentions(text: string, tag: string): boolean {
  if (!/^[a-z0-9_-]+$/.test(tag)) return text.includes(tag);
  return new RegExp(`(^|[^a-z0-9_-])${tag.replace(/-/g, "\\-")}([^a-z0-9_-]|$)`).test(text);
}

/**
 * Tags the tenant already uses that this conversation is about: named in the
 * title, or in at least two of its first messages (shown dashed, removable).
 * No model is asked; a tag mentioned once in passing is not suggested.
 */
function suggestTags(conversation: ParsedConversation, known: readonly TagCount[]): string[] {
  const title = conversation.title.toLowerCase();
  const first = conversation.messages.slice(0, SUGGEST_SCAN).map((message) => message.content.toLowerCase());
  return known
    .filter(({ tag }) => mentions(title, tag) || first.filter((text) => mentions(text, tag)).length >= 2)
    .slice(0, 3)
    .map(({ tag }) => tag);
}

function Restore({ parsed, conversation, checked, onChange, plan }: { parsed: ParsedImport; conversation: ParsedConversation; checked: boolean; onChange: (on: boolean) => void; plan: ReturnType<typeof buildImportPlan> }) {
  const t = useF13ImportT();
  // The messages that had other versions (the edited question, the regenerated reply).
  const where = conversation.messages.flatMap((message, index) => (message.versions > 1 ? [`#${index + 1}`] : [])).join("、");
  const count = conversation.branches.length;
  const notes = [
    conversation.skippedBranches > 0 ? t("import.restoreSkipped", { n: conversation.skippedBranches }) : null,
    checked && plan.droppedBranches > 0 ? t("import.restoreCapped", { n: plan.droppedBranches, limit: limitText(IMPORT_MAX_BRANCHES) }) : null,
    checked && plan.closedBranches > 0 ? t("import.restoreClosed", { n: plan.closedBranches }) : null,
    checked && plan.cutBranches > 0 ? t("import.restoreCut", { n: plan.cutBranches, limit: limitText(IMPORT_MAX_BRANCH_MESSAGES) }) : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 rounded-tg border border-tg-primary bg-tg-primary-soft/40 px-3 py-2.5">
      <Checkbox checked={checked} onCheckedChange={onChange}>
        <span className="font-medium">{parsed.source === "tangent" ? t("import.restoreBackup", { n: count }) : t("import.restoreBranches", { n: count })}</span>
      </Checkbox>
      <p className="m-0 pl-6 text-tg-xs text-tg-muted">
        {parsed.source === "tangent" ? "" : `${t("import.restoreWhich", { list: where })} `}
        {t("import.restoreHint")}
      </p>
      {notes.map((note) => (
        <p key={note} className="m-0 pl-6 text-tg-xs text-tg-muted">
          {note}
        </p>
      ))}
    </div>
  );
}

function MessageRow({ n, role, content, versions, removed, lastOne, touch, onToggleRole, onToggleRemoved }: { n: number; role: ImportRole; content: string; versions: number; removed: boolean; lastOne: boolean; touch: boolean; onToggleRole: () => void; onToggleRemoved: () => void }) {
  const t = useF13ImportT();
  const other = role === "user" ? "assistant" : "user";
  return (
    <li className={cx("flex items-center gap-2 rounded-tg-sm px-1.5 hover:bg-tg-accent", touch ? "min-h-11" : "min-h-8")}>
      <span className="w-8 shrink-0 font-tg-mono text-tg-xs text-tg-muted">#{n}</span>
      <button
        type="button"
        disabled={removed}
        aria-label={t("import.toggleRole", { role: t(`import.role.${other}`) })}
        onClick={onToggleRole}
        className={cx(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-tg-full border border-tg-border-input px-2 text-tg-xs focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45",
          role === "user" ? "bg-tg-accent" : "bg-tg-surface",
        )}
      >
        {t(`import.role.${role}`)}
        <ArrowLeftRight aria-hidden className="size-3 text-tg-muted" />
      </button>
      <span className={cx("min-w-0 flex-1 truncate text-tg-sm", removed && "line-through opacity-45")}>{previewLine({ content })}</span>
      {versions > 1 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-tg-full bg-tg-surface-sunken px-1.5 text-tg-xs text-tg-muted">
          <GitBranch aria-hidden className="size-3" />
          {t("import.versions", { n: versions })}
        </span>
      )}
      <button
        type="button"
        aria-label={removed ? t("import.restoreMsg", { n }) : t("import.removeMsg", { n })}
        title={!removed && lastOne ? t("import.lastOne") : undefined}
        aria-disabled={(!removed && lastOne) || undefined}
        onClick={() => (removed || !lastOne) && onToggleRemoved()}
        className={cx("grid shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-surface hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring aria-disabled:opacity-45", touch ? "size-9" : "size-6")}
      >
        {removed ? <Undo2 aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
      </button>
    </li>
  );
}

const bytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function ImportForm({ parsed, conversation, folders, known, touch, onCancel, onImported }: ImportFormProps) {
  const t = useF13ImportT();
  const ui = useUiT();
  const { hostErrorText } = useTangent();
  const importing = useImportConversation();
  const [roles, setRoles] = useState<Readonly<Record<string, ImportRole>>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState(conversation.title);
  // The select cannot hold "" as a choice: unfiled is the reserved filter name, which is never a folder.
  const [folderChoice, setFolderChoice] = useState(conversation.folder || FOLDER_UNFILED);
  const [newFolder, setNewFolder] = useState("");
  const suggested = useMemo(() => new Set(conversation.tags ? [] : suggestTags(conversation, known)), [conversation, known]);
  const [tags, setTags] = useState<string[]>(() => conversation.tags ?? [...suggested]);
  const [restore, setRestore] = useState(true);
  const [part, setPart] = useState(0);
  const folder = folderChoice === NEW_FOLDER ? newFolder : folderChoice === FOLDER_UNFILED ? "" : folderChoice;
  const labels = useMemo(() => ({ edit: (text: string) => t("import.purposeEdit", { text }), regenerate: (text: string) => t("import.purposeRegenerate", { text }) }), [t]);
  // Rebuilt only when what it reads changes (it serialises the whole body to measure it).
  const plan = useMemo(
    () => buildImportPlan(conversation, { roles, removed }, { title, folder, tags, restoreBranches: restore, source: parsed.source, part }, labels),
    [conversation, roles, removed, title, folder, tags, restore, parsed.source, part, labels],
  );
  const kept = conversation.messages.length - removed.size;
  const blocked = plan.problems.length > 0 || importing.isPending;
  const submit = (decompose: boolean) => {
    if (blocked) return;
    // The promise, not mutate's callbacks: the new conversation opens even if the dialog went away meanwhile.
    importing.mutateAsync(plan.input).then(
      (result) => onImported(result, decompose),
      () => undefined,
    );
  };
  const toggle = <T,>(set: ReadonlySet<T>, value: T) => (set.has(value) ? new Set([...set].filter((item) => item !== value)) : new Set([...set, value]));
  const problemText = plan.problems.map((problem) => {
    switch (problem.kind) {
      case "noMessages":
        return t("import.noMessages");
      case "tooLong":
        return problem.numbers.length === 1 ? t("import.tooLongOne", { list: problem.numbers[0]! }) : t("import.tooLongMany", { list: problem.numbers.join("、#") });
      case "bodyTooLarge":
        return t("import.bodyTooLarge", { size: bytes(problem.bytes) });
      case "folder":
        return problem.problem === "reserved" ? t("import.folderReserved") : t("import.folderTooLong");
      case "tags":
        return problem.problem === "tooMany" ? t("import.tagsTooMany") : t("import.tagsTooLong");
    }
  });
  return (
    <>
      {parsed.branchesPossible && conversation.branches.length > 0 && <Restore parsed={parsed} conversation={conversation} checked={restore} onChange={setRestore} plan={plan} />}
      {parsed.guessedRoles && <ErrorAlert tone="warning">{t("import.guessedRoles")}</ErrorAlert>}
      {plan.parts > 1 && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-tg-sm text-tg-foreground">{t("import.parts", { n: kept, limit: limitText(IMPORT_MAX_MESSAGES) })}</p>
          <Select
            aria-label={t("import.parts", { n: kept, limit: limitText(IMPORT_MAX_MESSAGES) })}
            value={String(part)}
            onValueChange={(value) => setPart(Number(value))}
            options={Array.from({ length: plan.parts }, (_, index) => ({ value: String(index), label: t("import.part", { from: index * IMPORT_MAX_MESSAGES + 1, to: Math.min(kept, (index + 1) * IMPORT_MAX_MESSAGES) }) }))}
          />
        </div>
      )}
      <section aria-label={t("import.preview")} className="flex shrink-0 flex-col">
        <ol tabIndex={-1} className="m-0 flex max-h-75 min-h-24 shrink-0 list-none flex-col gap-0.5 overflow-auto rounded-tg border border-tg-border bg-tg-surface p-1">
          {conversation.messages.map((message, index) => (
            <MessageRow
              key={message.externalId}
              n={index + 1}
              role={roles[message.externalId] ?? message.role}
              content={message.content}
              versions={restore ? message.versions : 1}
              removed={removed.has(message.externalId)}
              lastOne={kept <= 1}
              touch={touch}
              onToggleRole={() => setRoles((before) => ({ ...before, [message.externalId]: (before[message.externalId] ?? message.role) === "user" ? "assistant" : "user" }))}
              onToggleRemoved={() => setRemoved((before) => toggle(before, message.externalId))}
            />
          ))}
        </ol>
      </section>
      <div className={cx("grid gap-3", !touch && "grid-cols-2")}>
        <TextField label={t("import.titleField")} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className="col-span-full" />
        <div className="flex flex-col gap-1.5">
          <Select
            label={t("import.folderField")}
            value={folderChoice}
            onValueChange={setFolderChoice}
            options={[{ value: FOLDER_UNFILED, label: t("import.folderNone") }, ...folders.filter((name) => name !== FOLDER_UNFILED).map((name) => ({ value: name, label: name })), { value: NEW_FOLDER, label: t("import.folderNew") }]}
          />
          {folderChoice === NEW_FOLDER && <TextField aria-label={t("import.folderNewField")} placeholder={t("import.folderNewField")} value={newFolder} onChange={(event) => setNewFolder(event.target.value)} />}
        </div>
        <TagInput label={t("import.tagsField")} tags={tags} onChange={setTags} known={known} suggested={suggested} touch={touch} />
      </div>
      {problemText.length > 0 && (
        <ErrorAlert>
          {problemText.map((text) => (
            <span key={text}>{text}</span>
          ))}
        </ErrorAlert>
      )}
      {importing.error && <ErrorAlert>{t("import.failed", { reason: describeError(importing.error, ui, hostErrorText) })}</ErrorAlert>}
      <div className={cx("sticky bottom-0 -mx-5 -mb-4 flex gap-2 border-t border-tg-border bg-tg-surface-sunken px-5 py-3", touch ? "flex-col-reverse" : "items-center")}>
        <span className={cx("text-tg-xs text-tg-muted", touch ? "text-center" : "mr-auto")}>{t("import.summary", { n: plan.messageCount, b: plan.branchCount })}</span>
        <Button variant="ghost" disabled={importing.isPending} onClick={onCancel}>
          {t("import.cancel")}
        </Button>
        <Button aria-disabled={blocked || undefined} onClick={() => submit(false)}>
          {importing.isPending ? t("import.importing") : t("import.plain")}
        </Button>
        <Button variant="primary" icon={<Sparkles aria-hidden className="size-3.5" />} aria-disabled={blocked || undefined} onClick={() => submit(true)}>
          {t("import.withDecompose")}
        </Button>
      </div>
    </>
  );
}
