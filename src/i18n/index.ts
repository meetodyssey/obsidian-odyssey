import { en, type LocaleKey } from "./en";
import { zh } from "./zh";

type Vars = Record<string, string | number>;

const LOCALES: Record<string, Partial<Record<LocaleKey, string>>> = { en, zh };

function currentLanguage(): string {
  const lang = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

export function t(key: LocaleKey, vars?: Vars): string {
  const lang = currentLanguage();
  const str = LOCALES[lang]?.[key] ?? en[key];
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`));
}
