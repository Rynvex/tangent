import { branchesToMarkdown, branchesToMermaid, branchesToOpml, downloadText, exportFileName, type BranchView, type ExportLabels } from "@tangent/client";
import { Download } from "lucide-react";
import { Button } from "../components/button";
import { STATUS_KEYS } from "../conversation/models";
import { useUiT } from "../provider";

type Download = (fileName: string, mime: string, text: string) => void;

export interface ExportBarProps {
  /** The conversation's title (file name and root). */
  title: string;
  /** The tree's outline. */
  branches: readonly BranchView[];
  /** Defaults to a browser download; tests pass a spy. */
  download?: Download;
}

const FORMATS = [
  { label: "Markdown", extension: "md", mime: "text/markdown", build: branchesToMarkdown },
  { label: "Mermaid", extension: "mmd", mime: "text/plain", build: branchesToMermaid },
  { label: "OPML", extension: "opml", mime: "text/x-opml", build: branchesToOpml },
] as const;

/** Export the outline (A8): a Markdown list, a Mermaid mindmap or OPML; branches only, no messages. */
export function ExportBar({ title, branches, download = downloadText }: ExportBarProps) {
  const t = useUiT();
  const labels: ExportLabels = { status: (status) => t(STATUS_KEYS[status]), conclusion: t("export.conclusion"), line: t("export.line") };
  return (
    <div role="group" aria-label={t("export.label")} className="flex flex-wrap items-center gap-1 border-t border-tg-border px-3 py-2 text-tg-xs text-tg-muted">
      <Download aria-hidden className="size-3.5" />
      <span aria-hidden>{t("export.label")}</span>
      {FORMATS.map((format) => (
        <Button key={format.label} variant="ghost" size="sm" onClick={() => download(exportFileName(title, format.extension), format.mime, format.build(title, branches, labels))}>
          {format.label}
        </Button>
      ))}
    </div>
  );
}
