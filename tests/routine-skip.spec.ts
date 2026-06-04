import { test, expect } from "../fixtures/auth";
import { fetchUserSnapshot } from "../support/apiClient";

/**
 * Mobile skip flow — the escape hatch of the check-in loop.
 *
 * Why this matters: the skip button used to be `opacity-0 group-hover:opacity-100`,
 * which made it INVISIBLE on touch devices (hover never fires), forcing mobile
 * users into a false "check" or abandonment (UX audit critical #1). The fix makes
 * it always visible. Playwright's `toBeVisible()` treats opacity:0 elements as
 * visible, so the real regression guard here is the computed `opacity: 1`
 * WITHOUT any hover interaction.
 *
 * We also lock in the skip semantics: skipping must NOT award XP or constance
 * (only `POST /routine/check` does), the item shows its "Skipped" state, and
 * the action is reversible via "Undo skip".
 */
test.describe("Routine skip (mobile)", () => {
  test("skip button is visible without hover, skips without XP, and is reversible", async ({
    authedPage,
    seedFullOnboarding,
    api,
    testUser,
  }) => {
    await seedFullOnboarding();

    await authedPage.setViewportSize({ width: 375, height: 812 });
    await authedPage.goto("/dashboard");

    const habitRow = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Drink water" });
    const skipButton = habitRow.getByRole("button", { name: "Skip" }).first();

    await test.step("skip button is fully visible without hover", async () => {
      await expect(skipButton).toBeVisible();
      // The pre-fix bug: opacity-0 until group-hover — impossible on touch.
      await expect(skipButton).toHaveCSS("opacity", "1");
    });

    await test.step("skipping marks the item and awards no XP", async () => {
      await Promise.all([
        authedPage.waitForResponse(
          (response) =>
            response.url().endsWith("/routine/skip") && response.ok(),
        ),
        skipButton.click(),
      ]);

      await expect(habitRow.getByText("Skipped", { exact: true })).toBeVisible();

      const after = await fetchUserSnapshot(api.ctx, {
        email: testUser.email,
        password: testUser.password,
      });
      expect(after.xp).toBe(0);
      expect(after.constance).toBe(0);
    });

    await test.step("undo skip restores the item", async () => {
      const undoButton = habitRow
        .getByRole("button", { name: "Undo skip" })
        .first();
      await expect(undoButton).toBeVisible();

      await Promise.all([
        authedPage.waitForResponse(
          (response) =>
            response.url().endsWith("/routine/skip") && response.ok(),
        ),
        undoButton.click(),
      ]);

      await expect(
        habitRow.getByText("Skipped", { exact: true }),
      ).toHaveCount(0);
      await expect(
        habitRow.getByRole("button", { name: "Skip" }).first(),
      ).toBeVisible();
    });
  });
});
