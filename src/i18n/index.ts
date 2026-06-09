import { en, type TKey } from "./en";
import { ru } from "./ru";

const dicts: Record<string, Partial<Record<TKey, string>>> = { en, ru };
let locale = "en";

// Язык — из настройки интерфейса Obsidian (localStorage["language"]), не из ОС.
export const detectLocale = (): string => {
  try {
    const l = window.localStorage.getItem("language");
    return l && dicts[l] ? l : "en";
  } catch {
    return "en";
  }
};

export const setLocale = (l: string): void => {
  locale = dicts[l] ? l : "en";
};

// Перевод по ключу + интерполяция {var}. Фолбэк: текущий язык → en → сам ключ.
export const t = (key: TKey, vars?: Record<string, string | number>): string => {
  const s = dicts[locale]?.[key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
};
