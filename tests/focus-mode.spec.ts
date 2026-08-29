import { test, expect } from "../fixtures/auth";
import { fetchUserSnapshot } from "../support/apiClient";

/**
 * Focus Mode F1: today's routine, full screen, with nothing else on it.
 *
 * Why this needs a browser and not a unit test. The focus screen is a
 * `fixed inset-0 z-[70]` layer drawn OVER the app shell, because `ProtectedRoute`
 * mounts the sidebar, the bottom bar and the assistant bubble on every authenticated
 * route. Two things about that arrangement are invisible to jsdom:
 *
 *   1. Whether the layer actually sits on top. The shell stays mounted underneath, so
 *      nothing in the DOM says it is covered; only a real hit test does.
 *   2. Whether a check still lands. The rows are `sr-only` inputs with a ring drawn on
 *      top, inside a stacking context that now has a `fixed` ancestor. A z-index the
 *      wrong way round leaves a screen that looks perfect and cannot be used, and every
 *      unit test stays green.
 *
 * The reload step is the third rule: the screen fetches the routine AND the habits and
 * tasks itself, because the routine only carries item groups and the renderer draws
 * nothing for a group whose habit it cannot resolve. Wiping the persisted store before
 * navigating is what proves that fetch exists.
 */
test.describe("Focus mode", () => {
  test("covers the shell, checks an item, and hands the day back on exit", async ({
    authedPage,
    seedFullOnboarding,
    api,
    testUser,
  }) => {
    await seedFullOnboarding();

    const before = await fetchUserSnapshot(api.ctx, {
      email: testUser.email,
      password: testUser.password,
    });
    expect(before.xp).toBe(0);

    await authedPage.goto("/dashboard");

    const focusScreen = authedPage.getByTestId("focus-screen");
    const enterFocus = authedPage.getByTestId("focus-enter");

    await test.step("the way in is offered on today's card", async () => {
      await expect(enterFocus).toBeVisible();
      await enterFocus.click();
      await expect(authedPage).toHaveURL(/\/focus$/);
      await expect(focusScreen).toBeVisible();
      // The routine came with it, rather than an empty shell of a screen.
      await expect(focusScreen.getByText("Morning routine")).toBeVisible();
    });

    await test.step("and is not offered again from inside", async () => {
      await expect(enterFocus).toHaveCount(0);
    });

    await test.step("the shell is underneath, not on top", async () => {
      // The sidebar is still mounted; the question is which element a click at its
      // coordinates would reach. Anything but the focus layer means the screen is
      // covered by chrome it was built to hide.
      const sidebar = authedPage.getByRole("navigation").first();
      const box = await sidebar.boundingBox();
      expect(box).not.toBeNull();

      const hit = await authedPage.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return {
            insideFocus: Boolean(element?.closest('[data-testid="focus-screen"]')),
            tag: element?.tagName ?? "none",
          };
        },
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
      );

      expect(hit.insideFocus, `a click there would land on ${hit.tag}`).toBe(true);
    });

    const habitRow = focusScreen
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Drink water" });
    const checkbox = habitRow.locator('input[type="checkbox"]').first();
    // Click the LABEL, not the input: the input is `sr-only` with the ring drawn over
    // it, so the input itself fails Playwright's hit-target test. Same reason as
    // routine-checkin.spec.ts.
    const checkToggle = habitRow.locator('label:has(input[type="checkbox"])').first();

    await test.step("a check placed from inside focus reaches the backend", async () => {
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();

      await Promise.all([
        authedPage.waitForResponse(
          (response) => response.url().endsWith("/routine/check") && response.ok(),
        ),
        checkToggle.click(),
      ]);
      await expect(checkbox).toBeChecked();

      const after = await fetchUserSnapshot(api.ctx, {
        email: testUser.email,
        password: testUser.password,
      });
      expect(after.xp).toBeGreaterThan(before.xp);
    });

    await test.step("leaving returns to the dashboard with the check still there", async () => {
      await authedPage.getByTestId("focus-exit").click();
      await expect(authedPage).toHaveURL(/\/dashboard$/);
      await expect(focusScreen).toHaveCount(0);
      await expect(enterFocus).toBeVisible();
      await expect(
        authedPage
          .locator("div")
          .filter({ has: authedPage.locator('input[type="checkbox"]') })
          .filter({ hasText: "Drink water" })
          .locator('input[type="checkbox"]')
          .first(),
      ).toBeChecked();
    });
  });

  test("opened cold, it fetches the routine and the habits behind it", async ({
    authedPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();

    // Land once so the app is booted and the tutorial bypass is in place.
    await authedPage.goto("/dashboard");
    await expect(authedPage.getByTestId("focus-enter")).toBeVisible();

    // Drop the persisted store, so nothing about the routine, the habits or the day's
    // progress survives. This is the bookmark / cold-reload case: without the screen's
    // own three-request fetch, the sections draw with no rows in them and the screen
    // looks broken rather than empty. The tutorial key is left alone.
    await authedPage.evaluate(() => localStorage.removeItem("persist:root"));

    await authedPage.goto("/focus");

    const focusScreen = authedPage.getByTestId("focus-screen");
    await expect(focusScreen).toBeVisible();
    await expect(focusScreen.getByText("Morning routine")).toBeVisible();
    // The row is the real assertion: its name comes from the habits slice, not from
    // the routine payload.
    await expect(focusScreen.getByText("Drink water")).toBeVisible();
  });
});
