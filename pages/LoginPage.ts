import { expect, Page } from "@playwright/test";
import { TestUser } from "../support/testData";

/**
 * Page Object for the login screen at /.
 */
export class LoginPage {
  constructor(private readonly page: Page) {}

  // --- locators ---

  readonly emailInput = () => this.page.getByTestId("login-email-input");
  readonly passwordInput = () => this.page.getByTestId("login-password-input");
  readonly submitButton = () => this.page.getByTestId("login-submit");

  // --- actions ---

  async goto() {
    await this.page.goto("/");
    await expect(this.emailInput()).toBeVisible();
  }

  async login(user: Pick<TestUser, "email" | "password">) {
    await this.emailInput().fill(user.email);
    await this.passwordInput().fill(user.password);
    await this.submitButton().click();
  }
}
