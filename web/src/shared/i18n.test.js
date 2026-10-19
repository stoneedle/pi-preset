import { afterEach, describe, expect, it } from 'vitest';
import { t, setLocaleDictionary, CUSTOM_LANGUAGES_KEY } from './i18n.js';
const LOCALE_KEY = 'pi-web:v1:locale';
import { loadLocale } from './locale-loader.js';

afterEach(() => {
  localStorage.clear();
  setLocaleDictionary(null);
});

describe('mobile UI language', () => {
  it('uses the English source and preserves unknown keys', () => {
    expect(t('remote.new')).toBe('New session');
    expect(t('missing.key')).toBe('missing.key');
  });
  it('loads only the selected locale and falls back for missing translations', async () => {
    localStorage.setItem(LOCALE_KEY, 'es');
    await loadLocale();
    expect(t('common.cancel')).toBe('Cancelar');
    expect(t('remote.new')).toBe('New session');
  });
  it('preserves a saved custom dictionary', async () => {
    localStorage.setItem(LOCALE_KEY, 'personal');
    localStorage.setItem(
      CUSTOM_LANGUAGES_KEY,
      JSON.stringify([{ code: 'personal', strings: { 'remote.new': 'My new task' } }]),
    );
    await loadLocale();
    expect(t('remote.new')).toBe('My new task');
    expect(t('remote.send')).toBe('Send');
  });
});
