import { test, expect } from "../fixtures/auth";
import { editUser } from "../support/apiClient";
import { LoginPage } from "../pages/LoginPage";
import { DashboardPage } from "../pages/DashboardPage";

/**
 * Bug 1 — profile state lost on hard reload.
 *
 * The `perfil` redux slice (theme, tutorial-completed flag, language, …) was
 * removed from redux-persist. Nothing repopulates it on a page refresh:
 * `useSilentRefresh` only trades the httpOnly cookie for a fresh in-memory JWT
 * — it never re-fetches the user profile. So on reload the slice resets to its
 * initialState and any server-saved preference silently reverts.
 *
 * These tests log in through the UI (which is the only path that dispatches the
 * profile into redux, from the login response), assert the preference applied,
 * then hard-reload and assert it survived. They FAIL on the current build and
 * should pass once the boot path restores the profile.
 *
 * Theme primaries come from Beyou-Frontend/src/components/utils/listOfThemes.tsx.
 */
const SUNSET_PRIMARY = "#FB923C"; // Sunset theme primary
const DEFAULT_PRIMARY = "#0082e1"; // beYou / beYouDark fallback primary

test.describe("Profile persistence across hard reload (Bug 1)", () => {
  test("a server-saved theme survives a page refresh", async ({
    page,
    api,
    testUser,
  }) => {
    // Seed a non-default theme on the backend (what ThemeSelector persists).
    await editUser(api.ctx, api.accessToken, { theme: "Sunset" });

    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    // UI login dispatches the profile (incl. themeInUse) into redux, so the
    // ThemeProvider applies the saved theme.
    await loginPage.goto();
    await loginPage.login(testUser);
    await dashboard.expectVisible();

    const readPrimary = () =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--primary").trim(),
      );

    // Sanity: the saved theme is applied right after login. If this fails, the
    // seed path is wrong (not the bug under test).
    await expect.poll(readPrimary).toBe(SUNSET_PRIMARY);

    // Hard reload — silent refresh restores the JWT; the theme must persist.
    await page.reload();
    await dashboard.expectVisible();

    // BUG: perfil resets and is never re-fetched, so --primary reverts to the
    // default. This assertion fails on the current build.
    await expect.poll(readPrimary).toBe(SUNSET_PRIMARY);
    expect(await readPrimary()).not.toBe(DEFAULT_PRIMARY);
  });

  test("a completed tutorial does not reappear after a refresh", async ({
    page,
    api,
    testUser,
  }) => {
    // Mark onboarding complete on the backend (what completeTutorial does).
    await editUser(api.ctx, api.accessToken, { isTutorialCompleted: true });

    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await loginPage.goto();
    await loginPage.login(testUser);
    await dashboard.expectVisible();

    const skipButton = page.getByRole("button", { name: "Skip tutorial" });

    // Correctly hidden right after login (perfil.isTutorialCompleted = true).
    await expect(skipButton).toHaveCount(0);

    // Hard reload.
    await page.reload();
    await dashboard.expectVisible();

    // BUG: perfil resets to isTutorialCompleted=false and the local phase key
    // was cleared on completion, so the onboarding modal re-seeds to "intro"
    // and the tutorial reappears for an already-onboarded user.
    await expect(skipButton).toHaveCount(0);
  });
});
