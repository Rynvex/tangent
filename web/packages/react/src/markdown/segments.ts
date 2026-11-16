// Markdown renderer component).
export interface TextSegment {
  kind: "fence" | "text";
  /** Offset of the segment's first character in the source. */
  start: number;
  text: string;
  /** Fences only: false when the closing fence never arrived (streaming). */
  isClosed: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function closesFence(line: string, marker: string): boolean {
  const found = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return found !== undefined && found[0] === marker[0] && found.length >= marker.length;
}

function opensFence(line: string): string | null {
  const match = FENCE_OPEN.exec(line);
  const marker = match?.[1];
  const info = match?.[2] ?? "";
  if (!marker) return null;
  return marker.startsWith("`") && info.includes("`") ? null : marker;
}

/** Splits Markdown into fenced code blocks and the prose between them. */
export function splitSegments(source: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let buffer: string[] = [];
  let bufferStart = 0;
  let offset = 0;
  let fenceMarker: string | null = null;
  let fenceStart = 0;

  const flushText = (): void => {
    if (buffer.length > 0) {
      segments.push({ kind: "text", start: bufferStart, text: buffer.join(""), isClosed: true });
    }
    buffer = [];
  };

  for (const line of source.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    if (fenceMarker === null) {
      const marker = opensFence(bare);
      if (marker) {
        flushText();
        fenceMarker = marker;
        fenceStart = offset;
        buffer = [line];
        bufferStart = offset;
      } else {
        if (buffer.length === 0) bufferStart = offset;
        buffer.push(line);
      }
    } else {
      buffer.push(line);
      if (closesFence(bare, fenceMarker)) {
        segments.push({ kind: "fence", start: fenceStart, text: buffer.join(""), isClosed: true });
        buffer = [];
        fenceMarker = null;
      }
    }
    offset += line.length;
  }
  if (fenceMarker !== null) {
    segments.push({ kind: "fence", start: fenceStart, text: buffer.join(""), isClosed: false });
  } else {
    flushText();
  }
  return segments;
}

/**
 * Offset of a block that is still being written (an unclosed fence or an odd
 * `$$`), or -1. Blocks starting at or after it must not be rendered as
 * diagrams or formulas yet.
 */
export function findOpenBlockOffset(source: string): number {
  for (const segment of splitSegments(source)) {
    if (segment.kind === "fence" && !segment.isClosed) return segment.start;
    if (segment.kind === "text") {
      const delimiters = [...segment.text.matchAll(/(?<!\\)\$\$/g)];
      if (delimiters.length % 2 === 1) return segment.start + (delimiters[delimiters.length - 1]?.index ?? 0);
    }
  }
  return -1;
}
