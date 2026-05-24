import { test, expect } from "../fixtures/auth";
import { LoginPage } from "../pages/LoginPage";
import { DashboardPage } from "../pages/DashboardPage";

/**
 * Logout round-trip.
 *
 * Three things must be true after logout, and they tend to break independently:
 *   1. Backend invalidates the refresh token cookie (no zombie sessions).
 *   2. Frontend purges redux-persist so PII isn't left in localStorage.
 *   3. Guard redirects an unauthed `/dashboard` visit back to `/`.
 *
 * After all that, the same credentials still log the user back in cleanly.
 */
test.describe("Logout", () => {
  test("logout clears the session and the user can log back in", async ({
    authedPage,
    testUser,
  }) => {
    const loginPage = new LoginPage(authedPage);
    const dashboard = new DashboardPage(authedPage);

    await test.step("log out from the configuration page", async () => {
      await authedPage.goto("/configuration");
      await authedPage.getByRole("button", { name: "Logout" }).click();
      // Header.onLogout uses window.location.href = "/" — wait for that nav.
      await authedPage.waitForURL("**/");
    });

    await test.step("redux-persist data is purged after logout", async () => {
      const persisted = await authedPage.evaluate(() =>
        window.localStorage.getItem("persist:root"),
      );
      // Either gone entirely, or shape exists but PII fields are reset.
      if (persisted) {
        expect(persisted).not.toContain(testUser.email);
        expect(persisted).not.toContain(testUser.name);
      }
    });

    await test.step("guard kicks an unauthed dashboard visit back to /", async () => {
      await authedPage.goto("/dashboard");
      await authedPage.waitForURL((url) => !url.pathname.startsWith("/dashboard"));
      // Login form should be on screen.
      await expect(loginPage.emailInput()).toBeVisible();
    });

    await test.step("the same credentials log the user back in", async () => {
      await loginPage.login({
        email: testUser.email,
        password: testUser.password,
      });
      await dashboard.expectVisible();
    });
  });
});
