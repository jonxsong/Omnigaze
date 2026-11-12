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

export type LandingLocale = "en" | "zh-CN";

interface LandingLocaleContextValue {
  locale: LandingLocale;
  setLocale: (locale: LandingLocale) => void;
}

const STORAGE_KEY = "omnigaze:landing-locale:v1";
const LandingLocaleContext = createContext<LandingLocaleContextValue | null>(null);

function isLandingLocale(value: string | null): value is LandingLocale {
  return value === "en" || value === "zh-CN";
}

export function LandingLocaleProvider({ children }: { children: ReactNode }) {
  // English is intentionally deterministic for both SSR and the first client render.
  const [locale, setLocaleState] = useState<LandingLocale>("en");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const savedLocale = window.localStorage.getItem(STORAGE_KEY);
        if (isLandingLocale(savedLocale)) {
          setLocaleState(savedLocale);
          return;
        }
      } catch {
        // Storage can be unavailable in privacy-restricted browsing contexts.
      }

      const prefersChinese = window.navigator.languages.some((language) =>
        language.toLowerCase().startsWith("zh"),
      );
      if (prefersChinese) setLocaleState("zh-CN");
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  const setLocale = useCallback((nextLocale: LandingLocale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {
      // The in-memory preference still works when persistence is unavailable.
    }
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return <LandingLocaleContext.Provider value={value}>{children}</LandingLocaleContext.Provider>;
}

export function useLandingLocale() {
  const context = useContext(LandingLocaleContext);
  if (!context) {
    throw new Error("useLandingLocale must be used within LandingLocaleProvider");
  }
  return context;
}
