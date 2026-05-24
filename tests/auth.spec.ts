import { test } from "@playwright/test";
import { RegisterPage } from "../pages/RegisterPage";
import { LoginPage } from "../pages/LoginPage";
import { DashboardPage } from "../pages/DashboardPage";
import { makeUser } from "../support/testData";

/**
 * Smoke test for the auth golden path.
 *
 * Stack assumptions (running locally before this test):
 *   - Backend on :8099 with SPRING_PROFILES_ACTIVE=e2e (auto-verify on)
 *   - Frontend on :3000 with VITE_API_URL=http://localhost:8099/api/v1
 *   - PostgreSQL up and reachable by the backend
 *
 * The test creates a brand-new user (random email per run), registers, logs
 * in, and verifies the dashboard renders. If any of those steps break, the
 * core "can a person sign up and use the app" path is broken.
 */
test.describe("Auth flow", () => {
  test("user can register, log in, and reach the dashboard", async ({
    page,
  }) => {
    const user = makeUser();

    const registerPage = new RegisterPage(page);
    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await test.step("register a new user", async () => {
      await registerPage.goto();
      await registerPage.registerAndWaitForSuccess(user);
    });

    await test.step("log in with the new credentials", async () => {
      await loginPage.goto();
      await loginPage.login(user);
    });

    await test.step("dashboard renders for the logged-in user", async () => {
      await dashboard.expectVisible();
    });
  });
});
