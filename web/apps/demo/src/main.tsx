import { createTangentClient, hasErrorCode, type TangentClient } from "@tangent/client";
import { loadLocale, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { loadFontsOnDemand } from "./frame/fonts";
import { readParams, type DemoParams } from "./frame/params";
import { costThresholdFor, localeFor, prefsStore, themeFor, usePrefs } from "./frame/prefs";
import { applyReadingFont } from "./frame/reading-font";
import { Shell } from "./shell";
import "@tangent/fonts/latin.css";
import "@tangent/fonts/serif.css";
import "./index.css";

/** Same-origin `/api`: the Vite dev server proxies it to the reference server. */
const API_BASE_URL = "/api";
/**
 * Which identity the dev proxy should use (vite.config.ts swaps it for the
 * matching bearer token, so no token ever reaches the page).
 */
const IDENTITY_HEADER = "X-Tangent-Demo-Identity";
/** A little latency so loading states show in mock mode. */
const MOCK_LATENCY_MS = 120;

/**
 * `VITE_TANGENT_API=http` talks to the reference server; anything else (the
 * default until the server exists, C1) uses the in-memory mock with scenario
 * 1, imported only in that case so a real build does not carry it.
 */
async function makeClient(params: DemoParams): Promise<TangentClient> {
  if (import.meta.env.VITE_TANGENT_API === "http") {
    return createTangentClient({ baseUrl: API_BASE_URL, headers: () => ({ [IDENTITY_HEADER]: params.identity }) });
  }
  const { createMockTangentClient, nasScenario } = await import("@tangent/client/testing");
  return createMockTangentClient({ latencyMs: MOCK_LATENCY_MS, scenario: nasScenario({ features: params.features }) });
}

const params = readParams(window.location.search);
/** `?lang=` wins over the settings' language (screenshots, tests); without either, the browser's. */
const urlLang = new URLSearchParams(window.location.search).get("lang");
const htmlLang = (locale: string) => {
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh")) return "zh-Hant-TW";
  if (lower.startsWith("ja")) return "ja";
  return "en";
};
const startLocale = localeFor(prefsStore.get(), urlLang, navigator.language);
document.documentElement.lang = htmlLang(startLocale);
loadFontsOnDemand(startLocale, params.theme);
// Before the first render, so answers never repaint in the other font (F10 §1).
applyReadingFont(document.documentElement, prefsStore.get().readingFont);

const container = document.getElementById("root");
if (!container) throw new Error("The #root element is missing from index.html.");

/** React Query's default: three more tries. */
const MAX_QUERY_RETRIES = 3;
/**
 * A line that is not there stays not there: no retries, so an address naming a deleted or purged
 * line gives way to the first conversation at once instead of after the retries' back-off (F18 §2.4).
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (failures, error) => failures < MAX_QUERY_RETRIES && !hasErrorCode(error, "line_not_found") } },
});
/** The component gallery is only for the e2e axe run; keep it out of the app bundle. */
const Gallery = lazy(() => import("./gallery").then((module) => ({ default: module.Gallery })));

/** The demo's preferences (prefs.ts) are read here, above the provider that takes the language and the cost threshold. */
function App({ client }: { client: TangentClient }) {
  const prefs = usePrefs();
  const locale = localeFor(prefs, urlLang, navigator.language);
  // G2: the settings' language and reading font apply at once, without a reload.
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    if (/^zh|^ja/i.test(locale)) loadFontsOnDemand(locale, "system");
  }, [locale]);
  useEffect(() => applyReadingFont(document.documentElement, prefs.readingFont), [prefs.readingFont]);
  return (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale={locale} readOnly={params.identity === "viewer"} costThreshold={costThresholdFor(prefs)}>
        {params.view === "gallery" ? (
          <Suspense>
            <Gallery params={params} />
          </Suspense>
        ) : (
          <Shell params={params} theme={themeFor(params, prefs)} prefs={prefs} onPrefsChange={prefsStore.set} />
        )}
      </TangentProvider>
    </QueryClientProvider>
  );
}

// The dictionary of the page's language downloads alongside the client (F5: only the locale in use is fetched),
// so the first render is already in that language. If it fails the page still renders, in English; the provider
// tries again and says so in the console (R9 G5).
void Promise.all([makeClient(params), loadLocale(startLocale).catch(() => undefined)]).then(([client]) =>
  createRoot(container).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  ),
);
