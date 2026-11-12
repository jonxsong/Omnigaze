export type AppLocale = "en" | "zh-CN";

export const APP_LOCALE_STORAGE_KEY = "omnigaze:app-locale:v1";
export const LEGACY_LANDING_LOCALE_STORAGE_KEY =
  "omnigaze:landing-locale:v1";

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isAppLocale(value: string | null): value is AppLocale {
  return value === "en" || value === "zh-CN";
}

export function detectAppLocale(languages: readonly string[]): AppLocale {
  return languages.some((language) =>
    language.toLowerCase().startsWith("zh"),
  )
    ? "zh-CN"
    : "en";
}

function migrateLegacyLocale(storage: LocaleStorage, locale: AppLocale) {
  try {
    storage.setItem(APP_LOCALE_STORAGE_KEY, locale);
    storage.removeItem(LEGACY_LANDING_LOCALE_STORAGE_KEY);
  } catch {
    // Keep the readable legacy value if the migration cannot be persisted.
  }
}

export function resolveAppLocale(
  storage: LocaleStorage,
  languages: readonly string[],
): AppLocale {
  try {
    const savedLocale = storage.getItem(APP_LOCALE_STORAGE_KEY);
    if (isAppLocale(savedLocale)) {
      try {
        storage.removeItem(LEGACY_LANDING_LOCALE_STORAGE_KEY);
      } catch {
        // The current shared preference remains authoritative.
      }
      return savedLocale;
    }

    const legacyLocale = storage.getItem(LEGACY_LANDING_LOCALE_STORAGE_KEY);
    if (isAppLocale(legacyLocale)) {
      migrateLegacyLocale(storage, legacyLocale);
      return legacyLocale;
    }
  } catch {
    // Language detection still works in privacy-restricted browsing contexts.
  }

  return detectAppLocale(languages);
}

export function persistAppLocale(
  storage: LocaleStorage,
  locale: AppLocale,
) {
  try {
    storage.setItem(APP_LOCALE_STORAGE_KEY, locale);
    storage.removeItem(LEGACY_LANDING_LOCALE_STORAGE_KEY);
  } catch {
    // The provider's in-memory preference remains usable without storage.
  }
}
