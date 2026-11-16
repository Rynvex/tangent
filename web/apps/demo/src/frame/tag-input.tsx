/**
 * TagInput (F13 S2, S5): the tags as chips with ×, typing adds one (Enter),
 * Backspace on an empty field removes the last; while typing, the existing
 * tags that match (with how many conversations use them) and 新增「#x」.
 * At 12 the field is disabled. Tags are normalised as the server stores them.
 */
import { normalizeTag, TAG_MAX_RUNES, TAGS_MAX, type TagCount } from "@tangent/client";
import { Plus, Tag, X } from "lucide-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { useF13ShellT } from "./f13-shell-messages";

export interface TagInputProps {
  label: string;
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  /** The tenant's tags with their counts, for the suggestions while typing. */
  known: readonly TagCount[];
  /** Tags shown dashed (suggested, still removable). */
  suggested?: ReadonlySet<string>;
  disabled?: boolean;
  /** Focus the field when it mounts (the popover's opening focus). */
  autoFocus?: boolean;
  /** Touch sizes (44px rows). */
  touch?: boolean;
  /** Shown next to the label ("3 / 12", 儲存中…). */
  aside?: ReactNode;
}

const MAX_SUGGESTIONS = 5;

export function TagInput({ label, tags, onChange, known, suggested, disabled = false, autoFocus = false, touch = false, aside }: TagInputProps) {
  const s = useF13ShellT();
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = tags.length >= TAGS_MAX;
  const typed = normalizeTag(text);
  const matches = typed ? known.filter((item) => item.tag.includes(typed) && !tags.includes(item.tag)).slice(0, MAX_SUGGESTIONS) : [];
  const offerNew = typed !== "" && !tags.includes(typed) && !known.some((item) => item.tag === typed);

  const add = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag || tags.includes(tag) || full) return setText("");
    if (Array.from(tag).length > TAG_MAX_RUNES) return setError(s("tags.tooLong", { max: TAG_MAX_RUNES }));
    setError(null);
    setText("");
    onChange([...tags, tag]);
  };
  const remove = (tag: string) => onChange(tags.filter((item) => item !== tag));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      add(text);
    } else if (event.key === "Backspace" && text === "" && tags.length > 0) {
      event.preventDefault();
      remove(tags.at(-1)!);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-tg-sm font-medium text-tg-foreground">
          {label}
        </label>
        {aside}
      </div>
      <div
        className={cx(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1.5 py-1 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-tg-ring",
          touch && "min-h-11",
          disabled && "opacity-45",
        )}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className={cx(
              "inline-flex h-6 items-center gap-1 rounded-tg-full border pr-0.5 pl-2 text-tg-xs",
              suggested?.has(tag) ? "border-dashed border-tg-suggestion text-tg-foreground" : "border-transparent bg-tg-primary-soft text-tg-primary-text",
            )}
          >
            #{tag}
            <button
              type="button"
              aria-label={s("tags.remove", { tag: `#${tag}` })}
              disabled={disabled}
              onClick={() => remove(tag)}
              className={cx("grid place-items-center rounded-tg-full text-current hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "size-8" : "size-5")}
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          disabled={disabled || full}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          placeholder={full ? s("tags.full") : s("tags.input")}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          className="h-7 min-w-24 flex-1 border-0 bg-transparent px-1 text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle disabled:cursor-not-allowed"
        />
      </div>
      {error && <p className="m-0 text-tg-xs text-tg-destructive">{error}</p>}
      {(matches.length > 0 || offerNew) && !full && (
        <div className="flex flex-col rounded-tg-sm border border-tg-border bg-tg-surface p-1">
          {matches.map((item) => (
            <button
              key={item.tag}
              type="button"
              onClick={() => add(item.tag)}
              aria-label={s("tags.existing", { tag: `#${item.tag}`, n: item.count })}
              className={cx("flex items-center gap-2 rounded-tg-sm px-2 text-left text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-11" : "h-8")}
            >
              <Tag aria-hidden className="size-3.5 text-tg-muted" />
              <span className="min-w-0 flex-1 truncate">#{item.tag}</span>
              <span className="text-tg-xs text-tg-muted">{s("list.folderCount", { n: item.count })}</span>
            </button>
          ))}
          {offerNew && (
            <button
              type="button"
              onClick={() => add(text)}
              className={cx("flex items-center gap-2 rounded-tg-sm px-2 text-left text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-11" : "h-8")}
            >
              <Plus aria-hidden className="size-3.5 text-tg-muted" />
              {s("tags.add", { tag: `#${typed}` })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
