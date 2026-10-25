/** @type {import('knip').KnipConfig} */
export default {
  entry: ['src/main.js!', 'src/sw.js!', 'src/**/*.test.js'],
  project: ['src/**/*.{js,svelte}!', '!src/**/*.test.js', '*.config.js'],
};
