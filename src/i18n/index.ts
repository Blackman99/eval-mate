import { createRequire } from 'module';
import i18next from 'i18next';

const _require = createRequire(import.meta.url);
const zhCN = _require('./locales/zh-CN.json');
const enUS = _require('./locales/en-US.json');

export const SUPPORTED_LANGS = ['zh-CN', 'en-US'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

// Initialise with all resources bundled — resolves synchronously (no async backend)
await i18next.init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export function t(key: string, lng: string, vars?: Record<string, unknown>): string {
  return i18next.t(key, { lng, ...vars }) as string;
}
