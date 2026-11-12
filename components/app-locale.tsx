"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type AppLocale,
  detectAppLocale,
  persistAppLocale,
  resolveAppLocale,
} from "@/lib/app-locale";

interface AppLocaleContextValue {
  hydrated: boolean;
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
}

const AppLocaleContext = createContext<AppLocaleContextValue | null>(null);

export function AppLocaleProvider({ children }: { children: ReactNode }) {
  // English is deterministic for SSR and the first client render.
  const [locale, setLocaleState] = useState<AppLocale>("en");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const languages = window.navigator.languages.length
        ? window.navigator.languages
        : [window.navigator.language];
      let nextLocale = detectAppLocale(languages);
      try {
        nextLocale = resolveAppLocale(window.localStorage, languages);
      } catch {
        // Accessing localStorage itself can fail in restricted contexts.
      }
      setLocaleState(nextLocale);
      setHydrated(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.lang = locale;
  }, [hydrated, locale]);

  useEffect(
    () => () => {
      // Surfaces outside this provider are still English-only.
      document.documentElement.lang = "en";
    },
    [],
  );

  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    try {
      persistAppLocale(window.localStorage, nextLocale);
    } catch {
      // The in-memory preference remains usable without storage access.
    }
  }, []);

  const value = useMemo(
    () => ({ hydrated, locale, setLocale }),
    [hydrated, locale, setLocale],
  );

  return (
    <AppLocaleContext.Provider value={value}>
      {children}
    </AppLocaleContext.Provider>
  );
}

export function useAppLocale() {
  const context = useContext(AppLocaleContext);
  if (!context) {
    throw new Error("useAppLocale must be used within AppLocaleProvider");
  }
  return context;
}
