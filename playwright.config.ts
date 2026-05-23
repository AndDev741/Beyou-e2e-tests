import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Beyou stack.
 *
 * Defaults assume the app is running locally:
 *   - Frontend at http://localhost:3000
 *   - Backend  at http://localhost:8099/api/v1 (with SPRING_PROFILES_ACTIVE=e2e)
 *
 * Override via env vars:
 *   - BASE_URL   — frontend URL (default http://localhost:3000)
 *   - API_URL    — backend URL  (default http://localhost:8099/api/v1)
 */
export default defineConfig({
  testDir: "./tests",

  // Per-test timeout. Most flows finish in <5s; padding for cold starts.
  timeout: 30_000,

  // assertion timeout (e.g. expect(...).toBeVisible() retries up to this)
  expect: { timeout: 5_000 },

  // Run tests in parallel across files. Within a file they stay sequential
  // unless explicitly opted into worker-scoped parallelism — easier to reason
  // about shared state (test users) per file.
  fullyParallel: false,

  // Fail-fast on CI to save minutes; locally, run everything.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporters: list to console + HTML report for debugging
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",

    // Capture trace on first retry so we can debug flaky CI failures locally
    // via `npx playwright show-trace path/to/trace.zip`.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",

    // Light timeout on individual actions like clicks and fills.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Add Firefox/WebKit later via:
    // { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // { name: "webkit",  use: { ...devices["Desktop Safari"] } },
  ],
});
