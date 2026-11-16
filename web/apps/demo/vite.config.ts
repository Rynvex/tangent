import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

/** Dev port registered for Tangent's web UI (DESIGN §10). */
const DEV_PORT = 5183;
/**
 * Where `/api` (REST and the `/api/events` SSE stream) goes in dev: the
 * reference server on :8120. Override with `TANGENT_API_PROXY=http://host:port`.
 */
const API_TARGET = process.env.TANGENT_API_PROXY ?? "http://localhost:8120";
/**
 * Bearer tokens the proxy adds (the reference server requires one unless it
 * runs in dev mode): `TANGENT_API_TOKEN` for the operator and
 * `TANGENT_API_VIEWER_TOKEN` for `?as=viewer`. They stay in the dev server;
 * the page only names the identity in IDENTITY_HEADER.
 */
const TOKENS: Readonly<Record<string, string | undefined>> = {
  operator: process.env.TANGENT_API_TOKEN,
  viewer: process.env.TANGENT_API_VIEWER_TOKEN,
};
const IDENTITY_HEADER = "x-tangent-demo-identity";

/** Swaps the demo's identity header for that identity's bearer token. */
function addToken(proxyReq: { setHeader(name: string, value: string): void; removeHeader(name: string): void }, identity: string | string[] | undefined): void {
  const name = typeof identity === "string" ? identity : "operator";
  proxyReq.removeHeader(IDENTITY_HEADER);
  const token = TOKENS[name] ?? (name === "viewer" ? undefined : TOKENS.operator);
  if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
}

/**
 * The font files worth preloading: the main UI weights' Latin subset only
 * (CJK slices load on demand through unicode-range).
 */
const PRELOAD_FONTS = [/IBMPlexSans-Regular-Latin1-[\w-]+\.woff2$/, /IBMPlexSans-SemiBold-Latin1-[\w-]+\.woff2$/];

/** Adds `<link rel="preload">` for PRELOAD_FONTS to the built index.html, under Vite's `base`. */
function preloadFonts(): Plugin {
  let base = "/";
  return {
    name: "tangent-preload-fonts",
    apply: "build",
    configResolved(config) {
      base = config.base.endsWith("/") ? config.base : `${config.base}/`;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const files = Object.keys(context.bundle ?? {}).filter((file) => PRELOAD_FONTS.some((pattern) => pattern.test(file)));
        return files.map<HtmlTagDescriptor>((file) => ({
          tag: "link",
          attrs: { rel: "preload", href: `${base}${file}`, as: "font", type: "font/woff2", crossorigin: "" },
          injectTo: "head",
        }));
      },
    },
  };
}

const ALLOWED_HOSTS = (process.env.VITE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadFonts()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    ...(ALLOWED_HOSTS.length > 0 ? { allowedHosts: ALLOWED_HOSTS } : {}),
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => addToken(proxyReq, req.headers[IDENTITY_HEADER]));
        },
      },
    },
  },
  preview: {
    port: DEV_PORT,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts stay files: inlined base64 would sit in the render-blocking CSS and never cache on its own.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
});
