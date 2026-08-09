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
   * A linha de cabeçalho do cartão: ícone, nome e as ações. Ancorar numa classe
   * (`border-primary`) parou de funcionar quando o cartão passou a usar os
   * tokens do redesenho; o pai imediato do título é estrutural e não muda com
   * a folha de estilo.
   */
  private cardOf(name: string): Locator {
    return this.habitCard(name).locator("xpath=..");
  }

  /**
   * Editar e excluir moram no topo do cartão desde o redesenho: no desktop
   * aparecem no hover (opacidade), no telefone ficam sempre à mostra. Opacidade
   * não bloqueia clique nem esconde do Playwright, então não há mais nada a
   * expandir antes de agir.
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
