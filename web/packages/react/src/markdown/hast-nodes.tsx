// Markdown renderer component).
import type { ElementContent, Root } from "hast";
import type { ReactNode } from "react";

function renderNode(node: ElementContent, key: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const classes = node.properties?.className;
  const className = Array.isArray(classes) ? classes.join(" ") : undefined;
  return (
    <span key={key} className={className}>
      {node.children.map(renderNode)}
    </span>
  );
}

/** Turns a lowlight tree into React elements; text stays text, never HTML. */
export function renderHighlightTree(tree: Root): ReactNode[] {
  return tree.children.map((child, index) => renderNode(child as ElementContent, index));
}
