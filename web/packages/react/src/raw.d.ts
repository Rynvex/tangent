/** Vite / Vitest `?raw` imports: the file's text. */
declare module "*?raw" {
  const content: string;
  export default content;
}

/** Vite / Vitest `import.meta.glob` (eager form only; the token guard test uses it). */
interface ImportMeta {
  glob<T>(patterns: string | readonly string[], options: { query?: string; import?: string; eager: true }): Record<string, T>;
}

/** Plain CSS imports (the KaTeX stylesheet is imported dynamically). */
declare module "*.css";
