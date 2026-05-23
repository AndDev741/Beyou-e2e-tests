import { expect, Page } from "@playwright/test";

/**
 * Page Object for the authenticated dashboard at /dashboard.
 *
 * The "I am logged in" assertion uses two signals:
 *   1. URL contains /dashboard (router-level)
 *   2. The greeting h2 is visible (render-level, identified by data-testid)
 *
 * Both must pass before we trust that auth + initial data load completed.
 */
export class DashboardPage {
  constructor(private readonly page: Page) {}

  /** Greeting in the perfil header, e.g. "Good Morning, E2E User abc1". */
  readonly greeting = () => this.page.getByTestId("dashboard-greeting");

  /** Asserts we are on the dashboard with a logged-in user header. */
  async expectVisible() {
    await this.page.waitForURL(/\/dashboard/);
    await expect(this.greeting()).toBeVisible();
  }
}
