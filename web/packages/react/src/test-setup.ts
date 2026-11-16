import "@testing-library/jest-dom/vitest";
import { registerLocale } from "./i18n";
import { ja } from "./i18n/ja";
import { zhTW } from "./i18n/zh-TW";

// The zh-TW and ja dictionaries are lazy chunks in the app (F5); tests have them at once.
registerLocale("zh-TW", zhTW);
registerLocale("ja", ja);
