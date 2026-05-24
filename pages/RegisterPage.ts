import { expect, Page } from "@playwright/test";
import { TestUser } from "../support/testData";

/**
 * Page Object for the registration screen at /register.
 *
 * Selectors use data-testid attributes wired through the React components.
 * They survive i18n changes, CSS refactors, and DOM restructures — only a
 * deliberate rename of the testId can break them, and that is a feature.
 */
export class RegisterPage {
  constructor(private readonly page: Page) {}

  // --- locators ---

  readonly nameInput = () => this.page.getByTestId("register-name-input");
  readonly emailInput = () => this.page.getByTestId("register-email-input");
  readonly passwordInput = () => this.page.getByTestId("register-password-input");
  readonly submitButton = () => this.page.getByTestId("register-submit");

  // --- actions ---

  async goto() {
    await this.page.goto("/register");
    await expect(this.nameInput()).toBeVisible();
  }

  async fill(user: TestUser) {
    await this.nameInput().fill(user.name);
    await this.emailInput().fill(user.email);
    await this.passwordInput().fill(user.password);
  }

  async submit() {
    await this.submitButton().click();
  }

  /**
   * Convenience: fill and submit. Does NOT assert any post-submit state — the
   * caller decides what success or failure looks like.
   */
  async register(user: TestUser) {
    await this.fill(user);
    await this.submit();
  }

  /**
   * Fill, submit, and wait for the SPA's natural redirect to `/?verify=true`.
   * Prevents a race where the next test step (e.g. `loginPage.goto("/")`)
   * cancels the in-flight register POST before the user lands in the DB.
   */
  async registerAndWaitForSuccess(user: TestUser) {
    await Promise.all([
      this.page.waitForResponse(
        (response) =>
          response.url().endsWith("/auth/register") && response.ok(),
      ),
      this.register(user),
    ]);
    await this.page.waitForURL(/\?verify=true/);
  }
}
