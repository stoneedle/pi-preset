import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 2,
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : [["list"]],
  use: {
    trace: "on-first-retry",
    // Each worker owns an isolated server/agent directory via lib/test.ts.
    // Worker teardown also stops its detached test runtimes.
  },
  projects: [
    { name: "Desktop Chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "Desktop Firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"] } },
    { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } },
    { name: "Mobile Safari", use: { ...devices["iPhone 13"] } },
    // iPad portrait (810px) -> mobile layout; landscape (~1080px) -> desktop layout.
    { name: "iPad", use: { ...devices["iPad (gen 7)"] } },
    { name: "iPad landscape", use: { ...devices["iPad (gen 7) landscape"] } },
  ],
});
