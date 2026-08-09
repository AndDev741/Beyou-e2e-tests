import { expect, Locator, Page } from "@playwright/test";

/**
 * Page Object for the Habits screen at /habits.
 *
 * Selectors are deliberately semantic (role + accessible name, form `name=`
 * attributes) so they survive CSS refactors and don't rely on test-only
 * markup. The trade-off: they're locale-coupled where the visible text is
 * translated. Tests assume the English locale (default i18next falls back
 * to en).
 */
export class HabitsPage {
  constructor(private readonly page: Page) {}

  /** Navigate to /habits. */
  async goto(): Promise<void> {
    await this.page.goto("/habits");
    await expect(this.page).toHaveURL(/\/habits/);
  }

  /** Locator for a habit card by its visible name (exact match). */
  habitCard(name: string): Locator {
    return this.page.getByRole("heading", { level: 2, name, exact: true });
  }

  async expectHabitVisible(name: string): Promise<void> {
    await expect(this.habitCard(name)).toBeVisible();
  }

  async expectHabitGone(name: string): Promise<void> {
    await expect(this.habitCard(name)).toHaveCount(0);
  }

  /**
   * The card's header row: icon, name and the actions. Anchoring on a class
   * (`border-primary`) stopped working once the card moved to the redesign's
   * tokens; the title's immediate parent is structural and does not change with
   * the stylesheet.
   */
  private cardOf(name: string): Locator {
    return this.habitCard(name).locator("xpath=..");
  }

  /**
   * Edit and delete live at the top of the card since the redesign: on desktop
   * they appear on hover (opacity), on a phone they are always in view. Opacity
   * neither blocks a click nor hides them from Playwright, so there is nothing
   * left to expand before acting.
   */
  async clickEdit(name: string): Promise<void> {
    await this.cardOf(name).getByRole("button", { name: "Edit" }).click();
  }

  async deleteHabit(name: string): Promise<void> {
    const card = this.cardOf(name);
    // The card's "Delete" opens a global confirmation dialog (DeleteModal
    // portals to document.body with role="dialog"); confirm inside it.
    await card.getByRole("button", { name: "Delete" }).click();
    await this.page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
  }
}
