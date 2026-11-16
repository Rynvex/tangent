import { Button, Dialog, DialogContent, formatKeys, Kbd, useShortcutsState, useShortcutText, useUiT } from "@tangent/react";
import { useId, useRef } from "react";
import { useShellT } from "./f8-shell-messages";
import { GROUP_TITLE_KEYS, shortcutSections, type ShortcutRow } from "./shortcut-groups";

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Row({ row, apple }: { row: ShortcutRow; apple: boolean }) {
  const t = useUiT();
  const s = useShellT();
  return (
    <div className="flex min-h-8 items-center gap-3 border-b border-tg-border py-1.5 last:border-b-0">
      <dt className="min-w-0 flex-1 text-tg-sm text-tg-foreground">
        {t(row.titleKey)}
        {row.firefox && <span className="ml-2 inline-block rounded-tg-sm bg-tg-warning-soft px-1.5 text-tg-xs text-tg-foreground">{s("shortcuts.firefox")}</span>}
      </dt>
      <dd className="m-0 inline-flex shrink-0 items-center gap-0.5">
        {formatKeys(row.keys, apple).map((label) => (
          <Kbd key={label}>{label}</Kbd>
        ))}
      </dd>
    </div>
  );
}

/**
 * 快捷鍵說明 (F8 S4, `?` or the command palette): every command that has keys
 * now, in four groups, as the host set them; keys turned off are not listed.
 * Keys Firefox keeps for itself are marked, with the palette as the way round.
 * The dialogs' xl width (760; the design asked 720), one column on phones; focus starts on 關閉 (the footer's).
 */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const s = useShellT();
  const ui = useUiT();
  const close = useRef<HTMLButtonElement>(null);
  const { commands, bindings, apple } = useShortcutsState();
  const palette = useShortcutText("palette.open") ?? "";
  const headingBase = useId();
  const sections = shortcutSections(commands, bindings);
  const anyFirefox = sections.some((section) => section.rows.some((row) => row.firefox));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={s("shortcuts.title")}
        description={s("shortcuts.description")}
        width="xl"
        hideClose
        initialFocus={close}
        footer={
          <>
            {anyFirefox && <p className="m-0 mr-auto min-w-0 flex-1 basis-60 self-center text-tg-xs text-tg-muted">{s("shortcuts.firefoxNote", { palette })}</p>}
            <Button ref={close} onClick={() => onOpenChange(false)}>
              {ui("ui.close")}
            </Button>
          </>
        }
      >
        {sections.length === 0 ? (
          <p className="m-0 text-tg-sm text-tg-muted">{s("shortcuts.none")}</p>
        ) : (
          <div className="grid grid-cols-1 gap-x-7 gap-y-5 sm:grid-cols-2">
            {sections.map((section) => {
              const headingId = `${headingBase}-${section.group}`;
              return (
                <section key={section.group} aria-labelledby={headingId} className="flex flex-col gap-1">
                  <h3 id={headingId} className="m-0 text-tg-xs font-semibold text-tg-muted">
                    {s(GROUP_TITLE_KEYS[section.group])}
                  </h3>
                  <dl className="m-0 flex flex-col">
                    {section.rows.map((row) => (
                      <Row key={row.id} row={row} apple={apple} />
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ShortcutsDialog;
