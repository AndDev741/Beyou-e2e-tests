import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { DashboardPage } from "../pages/DashboardPage";
import { makeUser } from "../support/testData";

/**
 * Hard refresh must keep the user logged in.
 *
 * JWTs live in axios memory and die on every page reload. The SPA recovers
 * by firing a silent `/auth/refresh` against the httpOnly refresh cookie on
 * mount — see `useSilentRefresh`. If that flow ever breaks (cookie SameSite
 * change, axios refactor, timing race) the app looks fine on login but
 * boots you back to /login on F5.
 *
 * The test drives the UI for login (so we exercise the real cookie-set
 * path) and then issues a hard reload to verify the SPA self-heals.
 */
test.describe("Auth persistence", () => {
  test("logged-in user survives a hard reload", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await test.step("register + log in via the UI", async () => {
      await registerPage.goto();
      await registerPage.registerAndWaitForSuccess(user);
      await loginPage.goto();
      await loginPage.login(user);
      await dashboard.expectVisible();
    });

    await test.step("hard reload still shows the dashboard", async () => {
      await page.reload();
      await dashboard.expectVisible();
    });

    await test.step("direct navigation to / lands back on the dashboard, not login", async () => {
      // A freshly opened tab on the same context shares the refresh cookie,
      // so the SPA's silent refresh should authenticate before any guard
      // redirect can kick in.
      await page.goto("/dashboard");
      await dashboard.expectVisible();
    });
  });
});
