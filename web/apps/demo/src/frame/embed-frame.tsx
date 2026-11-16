import { TangentRoot, useUiT } from "@tangent/react";
import type { ReactNode } from "react";
import { useViewportWidth } from "./hooks";

/** The embedded panel's width (components.md: 420 嵌入宿主側欄). */
const EMBED_WIDTH_PX = 420;
/** Below this the panel alone fills the window (the 420 e2e, phones). */
const HOST_CHROME_MIN_PX = 720;

/**
 * `?frame=embed`: Tangent as a 420px panel inside a mock dark developer tool
 * (the prototype's 宿主應用程式（示意）), all in the host theme. Narrow
 * windows show only the panel.
 */
export function EmbedFrame({ children }: { children: ReactNode }) {
  const t = useUiT();
  const width = useViewportWidth();
  if (width < HOST_CHROME_MIN_PX) return <>{children}</>;
  return (
    <TangentRoot theme="host" className="flex h-full overflow-hidden">
      <section aria-label={t("embed.host")} className="flex min-w-0 flex-1 flex-col border-r border-tg-border">
        <div role="presentation" className="flex h-9 shrink-0 items-center gap-4 border-b border-tg-border bg-tg-surface-sunken px-3 text-tg-xs text-tg-muted">
          <span className="font-semibold text-tg-foreground">{t("embed.host")}</span>
          <span>Elements</span>
          <span>Console</span>
          <span>Network</span>
          <span className="text-tg-primary-text">Tangent</span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-5 font-tg-mono text-tg-xs text-tg-muted">
          <span>{t("embed.body1")}</span>
          <span>{t("embed.body2")}</span>
        </div>
      </section>
      <div className="relative h-full shrink-0" style={{ width: EMBED_WIDTH_PX }}>
        {children}
      </div>
    </TangentRoot>
  );
}
