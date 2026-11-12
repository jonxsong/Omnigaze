import { describe, expect, it } from "vitest";
import {
  APP_LOCALE_STORAGE_KEY,
  detectAppLocale,
  LEGACY_LANDING_LOCALE_STORAGE_KEY,
  persistAppLocale,
  resolveAppLocale,
  type LocaleStorage,
} from "@/lib/app-locale";

class MemoryLocaleStorage implements LocaleStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("shared app locale preference", () => {
  it("migrates the legacy landing preference to the shared app key", () => {
    const storage = new MemoryLocaleStorage();
    storage.values.set(LEGACY_LANDING_LOCALE_STORAGE_KEY, "zh-CN");

    expect(resolveAppLocale(storage, ["en-US"])).toBe("zh-CN");
    expect(storage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(storage.getItem(LEGACY_LANDING_LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("prefers the shared preference over legacy and browser languages", () => {
    const storage = new MemoryLocaleStorage();
    storage.values.set(APP_LOCALE_STORAGE_KEY, "en");
    storage.values.set(LEGACY_LANDING_LOCALE_STORAGE_KEY, "zh-CN");

    expect(resolveAppLocale(storage, ["zh-Hant-TW"])).toBe("en");
    expect(storage.getItem(LEGACY_LANDING_LOCALE_STORAGE_KEY)).toBeNull();
  });

  it("detects Chinese browser variants only when no saved preference exists", () => {
    expect(detectAppLocale(["en-US", "zh-Hans-CN"])).toBe("zh-CN");
    expect(detectAppLocale(["en-US", "fr-FR"])).toBe("en");
  });

  it("persists updates under the shared key and retires the legacy key", () => {
    const storage = new MemoryLocaleStorage();
    storage.values.set(LEGACY_LANDING_LOCALE_STORAGE_KEY, "zh-CN");

    persistAppLocale(storage, "en");

    expect(storage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en");
    expect(storage.getItem(LEGACY_LANDING_LOCALE_STORAGE_KEY)).toBeNull();
  });
});
