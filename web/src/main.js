import { mount } from 'svelte';
import App from './App.svelte';
import { loadLocale } from './shared/locale-loader.js';

loadLocale()
  .catch(() => 'en')
  .then((locale) => {
    document.documentElement.lang = locale;
    mount(App, { target: document.getElementById('spa-root') });
  });
