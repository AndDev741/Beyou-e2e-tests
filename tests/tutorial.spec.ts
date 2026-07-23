import { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth";

/**
 * Onboarding tutorial coverage.
 *
 * `freshAuthedPage` keeps the tutorial flag untouched — that's the default
 * state for a newly registered user, which is when these flows fire.
 *
 * Tutorial structure:
 *   - OnboardingTutorial.tsx: a 5-step modal ending in "Get Started"
 *   - SpotlightTutorial.tsx: per-page tooltip + cutout. Some steps have
 *     `action: "click"` so clicking the highlighted element advances the
 *     spotlight (and usually navigates).
 *
 * The phase machine lives in `useDashboardTutorial` and friends; phases
 * progress: intro → dashboard → categories → habits-dashboard → habits →
 * routines-dashboard → routines → routines-summary → config-dashboard →
 * config → done.
 */
test.describe("Onboarding tutorial", () => {
  test("new user can skip the tutorial", async ({ freshAuthedPage }) => {
    await freshAuthedPage.goto("/dashboard");

    const skipButton = freshAuthedPage.getByRole("button", {
      name: "Skip tutorial",
    });

    await expect(skipButton).toBeVisible();
    await skipButton.click();

    await expect(skipButton).toHaveCount(0);
    await expect(freshAuthedPage).toHaveURL(/\/dashboard/);
  });

  test("new user can walk through the intro modal", async ({
    freshAuthedPage,
  }) => {
    await freshAuthedPage.goto("/dashboard");

    const nextButton = freshAuthedPage.getByRole("button", { name: "Next" });
    const getStarted = freshAuthedPage.getByRole("button", {
      name: "Get Started",
    });

    await expect(nextButton).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await nextButton.click();
    }
    await getStarted.click();

    // The fork screen offers "Personalized setup" vs "Hands-on tour".
    // Pick the manual path to reach the dashboard spotlight.
    await freshAuthedPage
      .getByRole("button", { name: "Hands-on tour" })
      .click();

    // Past the fork we're now in the dashboard spotlight phase, so the
    // SpotlightTutorial tooltip should show — the modal's "Skip tutorial"
    // button is gone, but the spotlight's "Skip tutorial" link appears.
    await expect(
      freshAuthedPage.getByRole("heading", { name: "Your Profile" }),
    ).toBeVisible();
  });

  /**
   * The big one. Walks the whole onboarding journey using pre-seeded data so
   * every "create your first X" gate auto-advances. We're testing the phase
   * state machine and navigation chain, not the in-form data entry — those
   * are covered by habits.spec.ts and (future) routines.spec.ts.
   *
   * One test was a deliberate choice: each phase depends on the previous one
   * completing, so splitting would just create N tests that fail in cascade
   * the moment the chain breaks. The `test.step` annotations carry the
   * granularity for the report.
   */
  test("new user can walk the full onboarding flow end to end", async ({
    freshAuthedPage,
    seedFullOnboarding,
  }) => {
    test.setTimeout(60_000);

    await seedFullOnboarding();
    const page = freshAuthedPage;

    await test.step("intro modal → click through to Get Started", async () => {
      await page.goto("/dashboard");
      const nextButton = page.getByRole("button", { name: "Next" });
      const getStarted = page.getByRole("button", { name: "Get Started" });
      await expect(nextButton).toBeVisible();
      for (let i = 0; i < 4; i++) {
        await nextButton.click();
      }
      await getStarted.click();
      // Choose the manual path through the fork screen.
      await page.getByRole("button", { name: "Hands-on tour" }).click();
    });

    await test.step("dashboard spotlight → click Categories shortcut", async () => {
      await expect(
        page.getByRole("heading", { name: "Your Profile" }),
      ).toBeVisible();
      await clickNext(page);

      await expect(
        page.getByRole("heading", { name: "Quick Shortcuts" }),
      ).toBeVisible();
      await clickNext(page);

      // Last step: clicking the highlighted Categories shortcut auto-advances
      // AND navigates the SPA to /categories (action: "click").
      await expect(
        page.getByRole("heading", { name: "Start with Categories" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Categories" }).click();
      await expect(page).toHaveURL(/\/categories/);
    });

    await test.step("category spotlight → finish (seeded category present)", async () => {
      // With `hasCategories: true` the categories spotlight skips the
      // create-category step and jumps straight to the list step.
      await expect(
        page.getByRole("heading", { name: "Your Category Appears Here" }),
      ).toBeVisible();
      await clickFinish(page);
    });

    await test.step("return to dashboard → click Habits shortcut", async () => {
      // Finishing the categories spotlight auto-navigates back to the dashboard.
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(
        page.getByRole("heading", { name: "Next: Habits" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Habits" }).click();
      await expect(page).toHaveURL(/\/habits/);
    });

    await test.step("habits spotlight → finish (seeded habit present)", async () => {
      await expect(
        page.getByRole("heading", { name: "Your Habit Appears Here" }),
      ).toBeVisible();
      await clickFinish(page);
    });

    await test.step("return to dashboard → click Routines shortcut", async () => {
      // Finishing the habits spotlight auto-navigates back to the dashboard.
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(
        page.getByRole("heading", { name: "Next: Routines" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Routines" }).click();
      await expect(page).toHaveURL(/\/routines/);
    });

    await test.step("routines spotlight → advance past schedule", async () => {
      // hasRoutines + hasScheduleToday → useRoutinesTutorial fast-forwards
      // straight to the schedule step. One Next click bumps the index to the
      // schedule-modal step, which trips the auto-advance back to /dashboard.
      await expect(
        page.getByRole("heading", { name: "Schedule for Today" }),
      ).toBeVisible();
      await clickNext(page);
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
    });

    await test.step("dashboard summary spotlight → click Config shortcut", async () => {
      await expect(
        page.getByRole("heading", { name: "Routine for Today" }),
      ).toBeVisible();
      await clickNext(page);

      await expect(
        page.getByRole("heading", { name: "Configuration" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Config" }).click();
      await expect(page).toHaveURL(/\/configuration/);
    });

    await test.step("config walkthrough → dashboard finale finishes the tutorial", async () => {
      // Config is now a per-section walkthrough: Profile → Appearance →
      // Preferences → Dashboard (4 steps). Its spotlight reuses each section's
      // own heading text, so we drive it by the tooltip's Next/Finish buttons
      // rather than by heading (which would also match the section <h2>).
      await clickNext(page); // Profile → Appearance
      await clickNext(page); // Appearance → Preferences
      await clickNext(page); // Preferences → Dashboard
      await clickFinish(page); // Dashboard (last) → navigate to the dashboard finale

      await expect(page).toHaveURL(/\/dashboard/);
      await page.getByTestId("tutorial-finale-done").click();

      // The finale's button completes the tutorial: backend flag flips, then the
      // hook clears the local phase (both async after the click).
      await expect
        .poll(
          async () =>
            page.evaluate(() =>
              window.localStorage.getItem("beyou.tutorial.phase"),
            ),
          { timeout: 10_000 },
        )
        .toBeNull();
    });
  });
});

/** Click the spotlight tooltip's "Next" button. */
async function clickNext(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Next" }).click();
}

/** Click the spotlight tooltip's "Finish" button (shown on the last step).
 * Exact match: the config page's Constance options ("…finished…", "…finishing…")
 * otherwise collide with a substring match on "Finish". */
async function clickFinish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Finish", exact: true }).click();
}
