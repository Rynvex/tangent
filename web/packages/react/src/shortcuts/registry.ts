/**
 * What the shortcut provider keeps outside React state: the handlers each
 * command currently has (a stack per id, so a nested registration wins and
 * the previous one comes back on unmount) and the Escape layers (open panels,
 * overlays) that take Esc before `nav.back`.
 */

export type Handler = () => void;
export interface HandlerRef {
  current: Handler;
}

/** Higher runs first. Overlay panels sit above everything a command does with Esc. */
export const ESCAPE_PRIORITY = { panel: 100, overlay: 200 } as const;

export interface EscapeLayer {
  priority: number;
  onEscape: HandlerRef;
}

export interface ShortcutRegistry {
  register(id: string, handler: HandlerRef): () => void;
  handler(id: string): HandlerRef | undefined;
  /** Ids with a handler; the same Set object until that list changes. */
  available(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  addEscapeLayer(layer: EscapeLayer): () => void;
  /** The layer Esc goes to: highest priority, newest first. */
  topEscapeLayer(): EscapeLayer | undefined;
}

export function createShortcutRegistry(always: readonly string[]): ShortcutRegistry {
  let stacks: ReadonlyMap<string, readonly HandlerRef[]> = new Map();
  let available: ReadonlySet<string> = new Set(always);
  let layers: readonly EscapeLayer[] = [];
  const listeners = new Set<() => void>();

  const update = (next: ReadonlyMap<string, readonly HandlerRef[]>) => {
    stacks = next;
    const ids = new Set([...always, ...[...next].filter(([, stack]) => stack.length > 0).map(([id]) => id)]);
    const same = ids.size === available.size && [...ids].every((id) => available.has(id));
    if (same) return;
    available = ids;
    for (const listener of listeners) listener();
  };

  return {
    register(id, handler) {
      update(new Map([...stacks, [id, [...(stacks.get(id) ?? []), handler]]]));
      return () => update(new Map([...stacks, [id, (stacks.get(id) ?? []).filter((item) => item !== handler)]]));
    },
    handler: (id) => stacks.get(id)?.at(-1),
    available: () => available,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addEscapeLayer(layer) {
      layers = [...layers, layer];
      return () => {
        layers = layers.filter((item) => item !== layer);
      };
    },
    topEscapeLayer() {
      // Later entries win ties: the newest overlay closes first.
      return layers.reduce<EscapeLayer | undefined>((top, layer) => (!top || layer.priority >= top.priority ? layer : top), undefined);
    },
  };
}
