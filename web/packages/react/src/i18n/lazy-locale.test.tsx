/**
 * F5 room-making: only the locale in use is downloaded. English is the
 * fallback and always present; zh-TW is a chunk of its own, loaded on demand
 * (`loadLocale`) or registered by a host that bundles it (`registerLocale`).
 * Each test imports a fresh module graph so the setup file's registration
 * does not leak in.
 */
import { createTangentClient } from "@tangent/client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const client = createTangentClient({ baseUrl: "/api", fetch: async () => new Response("{}") });

async function freshI18n() {
  vi.resetModules();
  return import("./index");
}

describe("lazy locales", () => {
  it("does not import the zh-TW or ja dictionaries statically", async () => {
    const { default: source } = await import("./index.ts?raw");
    expect(source).not.toMatch(/^import[^;]*from "\.\/zh-TW";/m);
    expect(source).not.toMatch(/^import[^;]*from "\.\/ja";/m);
    expect(source).toMatch(/import\("\.\/zh-TW"\)/);
    expect(source).toMatch(/import\("\.\/ja"\)/);
  });

  it("translates in English until zh-TW or ja is loaded, then in that locale", async () => {
    const i18n = await freshI18n();
    expect(i18n.localeMessages("zh-TW")).toBeUndefined();
    expect(i18n.localeMessages("ja")).toBeUndefined();
    expect(i18n.createTranslator("zh-TW")("breadcrumb.main")).toBe(i18n.localeMessages("en")?.["breadcrumb.main"]);
    expect(i18n.createTranslator("ja")("breadcrumb.main")).toBe(i18n.localeMessages("en")?.["breadcrumb.main"]);
    await i18n.loadLocale("zh-Hant-TW");
    expect(i18n.localeMessages("zh-TW")).toBeDefined();
    expect(i18n.createTranslator("zh-TW")("breadcrumb.main")).toBe("主線");
    await i18n.loadLocale("ja-JP");
    expect(i18n.localeMessages("ja")).toBeDefined();
    expect(i18n.createTranslator("ja")("breadcrumb.main")).toBe("メインライン");
  });

  it("loading English or an unknown locale resolves at once", async () => {
    const i18n = await freshI18n();
    await expect(i18n.loadLocale("fr")).resolves.toBeUndefined();
    expect(i18n.localeMessages("zh-TW")).toBeUndefined();
    expect(i18n.localeMessages("ja")).toBeUndefined();
  });

  it("a host can register a dictionary it bundles itself", async () => {
    const i18n = await freshI18n();
    const { zhTW } = await import("./zh-TW");
    i18n.registerLocale("zh-TW", zhTW);
    expect(i18n.createTranslator("zh-TW")("breadcrumb.main")).toBe("主線");
  });

  it("the provider renders English first and switches once the dictionary arrives", async () => {
    await freshI18n();
    const { TangentProvider, useTangentT } = await import("../provider");
    function Probe() {
      return <p>{useTangentT()("breadcrumb.main")}</p>;
    }
    render(
      <TangentProvider client={client} locale="zh-TW">
        <Probe />
      </TangentProvider>,
    );
    expect(screen.getByText("Main line")).toBeInTheDocument();
    expect(await screen.findByText("主線")).toBeInTheDocument();
  });

  it("R9 G5: a failed download keeps English, is not cached, and a later switch tries again", async () => {
    vi.resetModules();
    const { zhTW } = await import("./zh-TW");
    let calls = 0;
    vi.doMock("./zh-TW", () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { zhTW };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { TangentProvider, useTangentT } = await import("../provider");
      function Probe() {
        return <p>{useTangentT()("breadcrumb.main")}</p>;
      }
      const view = (locale: string) => (
        <TangentProvider client={client} locale={locale}>
          <Probe />
        </TangentProvider>
      );
      const { rerender } = render(view("zh-TW"));
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.getByText("Main line")).toBeInTheDocument();
      rerender(view("en"));
      rerender(view("zh-TW"));
      expect(await screen.findByText("主線")).toBeInTheDocument();
    } finally {
      warn.mockRestore();
      vi.doUnmock("./zh-TW");
    }
  });
});

