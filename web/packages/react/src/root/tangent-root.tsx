import { createContext, useCallback, useContext, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "../lib/cx";

/** `system` follows the OS (no data-tg-theme); `host` is the host theme. */
export type TangentTheme = "system" | "light" | "dark" | "host";
export type TangentDensity = "comfortable" | "compact";

/** Where popups (dialogs, menus, tooltips) render: inside the root, so they inherit its theme and fonts. */
const PortalContainerContext = createContext<HTMLElement | null>(null);
/** The root element itself (shortcuts listen on it). */
const RootElementContext = createContext<HTMLElement | null>(null);

/** The root's popup container; null outside a TangentRoot (Base UI then uses document.body). */
export function useTangentPortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

/** The TangentRoot element; null outside a root and during the very first render. */
export function useTangentRootElement(): HTMLElement | null {
  return useContext(RootElementContext);
}

export interface TangentRootProps extends Omit<ComponentPropsWithRef<"div">, "children" | "ref"> {
  theme?: TangentTheme;
  density?: TangentDensity;
  children: ReactNode;
}

/** A detached element created once on the client; null during server rendering. */
function usePortalHost(): HTMLElement | null {
  const [host] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.setAttribute("data-tg-portal", "");
    return element;
  });
  return host;
}

/**
 * The scope every Tangent surface renders in: sets `data-tg-theme` and
 * `data-tg-density`, the base type and tokens via `data-tg-root` (styles.css
 * applies nothing outside it), `isolation: isolate` so popups stack inside
 * it, and a popup container so portalled overlays keep the theme. Nest it
 * anywhere in the host page; it does not touch <html> or <body>.
 *
 * The popup container exists from the first render (a lazily created
 * element, attached by the first child's ref before any child's layout
 * effect runs), so even a `defaultOpen` popup never lands in <body>.
 */
export function TangentRoot({ theme = "system", density = "comfortable", className, children, ...rest }: TangentRootProps) {
  const host = usePortalHost();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const attachHost = useCallback(
    (slot: HTMLElement | null) => {
      if (slot && host && host.parentNode !== slot) slot.appendChild(host);
    },
    [host],
  );
  return (
    <div
      ref={setElement}
      data-tg-root=""
      data-tg-theme={theme === "system" ? undefined : theme}
      data-tg-density={density}
      className={cx("isolate bg-tg-background text-tg-foreground", className)}
      {...rest}
    >
      <div ref={attachHost} className="contents" />
      <RootElementContext.Provider value={element}>
        <PortalContainerContext.Provider value={host}>
          {children}
        </PortalContainerContext.Provider>
      </RootElementContext.Provider>
    </div>
  );
}
