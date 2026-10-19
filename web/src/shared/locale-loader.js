import { getLocale, setLocaleDictionary, CUSTOM_LANGUAGES_KEY } from './i18n.js';

const dictionaries = {
  es: () => import('./locales/es.js'),
  fr: () => import('./locales/fr.js'),
  de: () => import('./locales/de.js'),
  zh: () => import('./locales/zh.js'),
  ja: () => import('./locales/ja.js'),
  id: () => import('./locales/id.js'),
  ms: () => import('./locales/ms.js'),
  vi: () => import('./locales/vi.js'),
  th: () => import('./locales/th.js'),
  fil: () => import('./locales/fil.js'),
  my: () => import('./locales/my.js'),
  km: () => import('./locales/km.js'),
  lo: () => import('./locales/lo.js'),
};

export async function loadLocale() {
  const code = getLocale();
  const load = dictionaries[code];
  if (load) setLocaleDictionary((await load()).default);
  else {
    try {
      const custom = JSON.parse(localStorage.getItem(CUSTOM_LANGUAGES_KEY) || '[]');
      setLocaleDictionary(custom.find((item) => item.code === code)?.strings);
    } catch {
      setLocaleDictionary(null);
    }
  }
  return code;
}
