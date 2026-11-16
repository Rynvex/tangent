/**
 * @tangent/react — provider, i18n, query keys, design tokens, base
 * components, layout frame, shortcuts and the command palette (DESIGN §8).
 * Import the tokens with `@import "@tangent/react/styles.css";` after
 * `@import "tailwindcss";`, and the self-hosted fonts (optional) with
 * `import "@tangent/react/fonts.css"`.
 */
export * from "./provider";
export * from "./query-keys";
export * from "./i18n";
export { createBundleTranslator, useBundleT, type BundleTranslate, type MessageBundle } from "./i18n/bundle";
export type { P1MessageKey } from "./i18n/p1-messages";
export type { P2MessageKey } from "./i18n/p2-messages";
export type { P3MessageKey } from "./i18n/p3-messages";
export * from "./root/tangent-root";
export * from "./components";
export * from "./layout";
export * from "./shortcuts";
export * from "./data";
export * from "./markdown";
export * from "./conversation";
export * from "./branch";
export * from "./structure";
export * from "./notes";
export * from "./leaf";
export * from "./inbox";
export * from "./p2";
export * from "./groups";
export * from "./p3";
export * from "./memory";
export * from "./focus";
export * from "./export";
export * from "./f8";
export * from "./f13";
export * from "./glossary";
