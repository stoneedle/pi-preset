import en from './locales/en.js';

const LOCALE_KEY = 'pi-web:v1:locale';
export const CUSTOM_LANGUAGES_KEY = 'pi-web:v1:custom-languages';
let dictionary = en;

export function getLocale(storage) {
  try {
    return (storage || globalThis.localStorage).getItem(LOCALE_KEY) || 'en';
  } catch {
    return 'en';
  }
}

export function setLocaleDictionary(strings) {
  dictionary = strings || en;
}

export function t(key, params = {}) {
  const value = typeof dictionary[key] === 'string' ? dictionary[key] : (en[key] ?? key);
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}
