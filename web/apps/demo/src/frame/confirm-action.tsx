import { Button, Dialog, DialogClose, DialogContent, useBundleT, type MessageBundle } from "@tangent/react";
import { useRef } from "react";

const en = {
  "confirm.unpinTitle": "Unpin “{title}”?",
  "confirm.unpinBody": "It goes back to its place by date in the list.",
  "confirm.unpin": "Unpin",
  "confirm.archiveTitle": "Archive “{title}”?",
  "confirm.archiveBody": "It leaves the list; you can restore it from the archive (the list's bottom, or Settings → Archive).",
  "confirm.archive": "Archive",
  "confirm.cancel": "Cancel",
};

export type ConfirmMessageKey = keyof typeof en;

const zhTW: Record<ConfirmMessageKey, string> = {
  "confirm.unpinTitle": "取消置頂「{title}」？",
  "confirm.unpinBody": "它會回到清單裡依日期排列的位置。",
  "confirm.unpin": "取消置頂",
  "confirm.archiveTitle": "封存「{title}」？",
  "confirm.archiveBody": "它會離開清單；之後可以從封存區（清單底部，或 設定 → 封存）還原。",
  "confirm.archive": "封存",
  "confirm.cancel": "取消",
};

const ja: Record<ConfirmMessageKey, string> = {
  "confirm.unpinTitle": "「{title}」のピン留めを解除しますか？",
  "confirm.unpinBody": "一覧の日付順の元の位置に戻ります。",
  "confirm.unpin": "ピン留め解除",
  "confirm.archiveTitle": "「{title}」をアーカイブしますか？",
  "confirm.archiveBody": "一覧から移動します。後でアーカイブ領域（一覧の末尾または 設定 → アーカイブ）から復元できます。",
  "confirm.archive": "アーカイブ",
  "confirm.cancel": "キャンセル",
};

const CONFIRM_MESSAGES: MessageBundle<ConfirmMessageKey> = { en, "zh-TW": zhTW, ja };

/** What the confirmation is about. */
export type ConfirmKind = "unpin" | "archive";

export interface ConfirmActionProps {
  kind: ConfirmKind | null;
  /** The conversation's title. */
  title: string;
  onConfirm: (kind: ConfirmKind) => void;
  onClose: () => void;
}

/**
 * The second question before unpinning or archiving a conversation (G2,
 * Settings → General → Confirmations; both off by default). Starts on 取消,
 * closes on Esc; the action runs only from its own button.
 */
export function ConfirmAction({ kind, title, onConfirm, onClose }: ConfirmActionProps) {
  const t = useBundleT(CONFIRM_MESSAGES);
  const cancel = useRef<HTMLButtonElement>(null);
  // The words stay while the dialog leaves.
  const shown = useRef<ConfirmKind>("archive");
  if (kind) shown.current = kind;
  const about = shown.current;
  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        width="sm"
        title={t(about === "unpin" ? "confirm.unpinTitle" : "confirm.archiveTitle", { title })}
        description={t(about === "unpin" ? "confirm.unpinBody" : "confirm.archiveBody")}
        initialFocus={cancel}
        hideClose
        footer={
          <>
            <DialogClose render={<Button ref={cancel}>{t("confirm.cancel")}</Button>} />
            <Button
              variant="primary"
              onClick={() => {
                onConfirm(about);
                onClose();
              }}
            >
              {t(about === "unpin" ? "confirm.unpin" : "confirm.archive")}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
