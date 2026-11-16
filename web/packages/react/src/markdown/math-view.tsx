// Markdown renderer component).
import { useEffect, useState } from "react";
import { useUiT } from "../provider";
import { renderTex } from "./katex-render";

type MathState = { status: "loading" } | { status: "ready"; html: string } | { status: "error"; message: string };

interface MathViewProps {
  source: string;
  isDisplay: boolean;
}

/** A formula rendered by KaTeX; the TeX source while loading and when it does not parse. */
export function MathView({ source, isDisplay }: MathViewProps) {
  const t = useUiT();
  const [state, setState] = useState<MathState>({ status: "loading" });

  useEffect(() => {
    let isCurrent = true;
    renderTex(source, isDisplay)
      .then((html) => {
        if (isCurrent) setState({ status: "ready", html });
      })
      .catch((error: unknown) => {
        if (isCurrent) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      isCurrent = false;
    };
  }, [source, isDisplay]);

  if (state.status === "ready") {
    // KaTeX escapes all text and, with trust off, emits no links, images or scripts.
    return isDisplay ? (
      <div data-tg-math="" className="my-3 overflow-x-auto" tabIndex={0} dangerouslySetInnerHTML={{ __html: state.html }} />
    ) : (
      <span data-tg-math="" dangerouslySetInnerHTML={{ __html: state.html }} />
    );
  }
  if (state.status === "error") {
    const Tag = isDisplay ? "pre" : "code";
    return (
      <Tag data-tg-math-error="" title={t("markdown.mathError", { message: state.message })}>
        {source}
      </Tag>
    );
  }
  return isDisplay ? (
    <pre data-tg-math-pending="" className="my-3 overflow-x-auto">
      {source}
    </pre>
  ) : (
    <code data-tg-math-pending="">{source}</code>
  );
}
