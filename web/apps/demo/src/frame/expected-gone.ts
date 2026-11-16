/**
 * Lines this page itself is replacing (F18 接著問: the aside's line goes and
 * a new branch takes its place). While one is on screen, its `line.deleted`
 * and a `line_not_found` of its reads are expected: the frame stays put and
 * the flow that asked goes to the new line, instead of flashing 「已不在了」.
 */
export const expectedGone = new Set<string>();
