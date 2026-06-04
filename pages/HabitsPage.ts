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

  /** The full card DOM node wrapping a habit identified by name. */
  private cardOf(name: string): Locator {
    return this.habitCard(name).locator(
      "xpath=ancestor::div[contains(@class,'border-primary')][1]",
    );
  }

  /**
   * Ensure the card is expanded so its Edit / Delete buttons are visible.
   * The toggle is a <button aria-label="Expand"|"Collapse">, so we only
   * click it when the action area is still hidden — otherwise we'd flip
   * it back closed.
   */
  async expandHabit(name: string): Promise<void> {
    const card = this.cardOf(name);
    const deleteButton = card.getByRole("button", { name: "Delete" }).first();
    if (await deleteButton.isVisible().catch(() => false)) {
      return;
    }
    await card.getByRole("button", { name: "Expand" }).click();
    await deleteButton.waitFor({ state: "visible" });
  }

  async clickEdit(name: string): Promise<void> {
    await this.expandHabit(name);
    await this.cardOf(name).getByRole("button", { name: "Edit" }).click();
  }

  async deleteHabit(name: string): Promise<void> {
    await this.expandHabit(name);
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
