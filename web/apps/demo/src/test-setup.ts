import "@testing-library/jest-dom/vitest";
import { loadLocale } from "@tangent/react";

// The zh-TW and ja dictionaries are lazy chunks in the app (F5); tests have them before they render.
await Promise.all([loadLocale("zh-TW"), loadLocale("ja")]);
