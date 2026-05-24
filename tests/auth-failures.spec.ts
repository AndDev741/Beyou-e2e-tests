import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { makeUser } from "../support/testData";

/**
 * Auth failure paths.
 *
 * These tests lock in the user-facing error messaging for the four scenarios
 * users hit most often:
 *   - wrong password
 *   - unknown email (must produce the same message — anti-enumeration)
 *   - weak password on register
 *   - invalid email format
 *
 * They're cheap and they make it impossible to accidentally regress an error
 * string (or, worse, leak which emails exist in the system).
 */
test.describe("Auth failure paths", () => {
  test("wrong password shows a generic toast", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);
    const loginPage = new LoginPage(page);

    await registerPage.goto();
    await registerPage.registerAndWaitForSuccess(user);

    await loginPage.goto();
    await loginPage.login({ email: user.email, password: "DifferentPass-123!" });

    await expect(
      page.getByRole("alert").filter({ hasText: "Wrong email or password" }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("unknown email shows the same toast (no enumeration leak)", async ({
    page,
  }) => {
    const loginPage = new LoginPage(page);

    await loginPage.goto();
    await loginPage.login({
      email: `ghost-${Date.now()}@beyou.local`,
      password: "AnyPassword-123!",
    });

    // Same message as the wrong-password case. Different text here would
    // tell an attacker which emails exist in the system.
    await expect(
      page.getByRole("alert").filter({ hasText: "Wrong email or password" }),
    ).toBeVisible();
  });

  test("weak password on register shows the strength rule inline", async ({
    page,
  }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();

    await registerPage.nameInput().fill("Test User");
    await registerPage.emailInput().fill(`weak-${Date.now()}@beyou.local`);
    await registerPage.passwordInput().fill("short");
    await registerPage.submit();

    // The 12-char-minimum rule fires first (the strength rule lives behind a
    // length check), so that's the message the user sees.
    await expect(
      page.getByText("Password must be at least 12 characters"),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("invalid email on register shows the email rule inline", async ({
    page,
  }) => {
    const registerPage = new RegisterPage(page);
    await registerPage.goto();

    await registerPage.nameInput().fill("Test User");
    await registerPage.emailInput().fill("not-an-email");
    await registerPage.passwordInput().fill("ValidPassword-123!");
    await registerPage.submit();

    await expect(page.getByText("Email is invalid")).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard/);
  });
});
