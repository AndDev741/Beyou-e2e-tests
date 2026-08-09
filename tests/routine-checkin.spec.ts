import { test, expect } from "../fixtures/auth";
import { fetchUserSnapshot } from "../support/apiClient";

/**
 * The golden engagement loop: check a habit on today's routine and watch
 * the user's XP + constance go up.
 *
 * Why this matters: the entire gamification model (XP/level/constance) sits
 * behind a single `POST /routine/check` call that returns a `RefreshUiDTO`.
 * If anything in the pipeline (Hibernate lazy load, mapper, Redux dispatch,
 * Perfil binding) breaks, we silently lose feedback and the product is
 * effectively a flat to-do list.
 *
 * We assert two ways:
 *   1. Backend truth — re-fetch the user via API and compare XP/constance.
 *   2. UI persistence — reload the page and confirm the checkbox stays
 *      checked, so a refresh doesn't lose the user's progress.
 */
test.describe("Routine check-in", () => {
  test("checking a habit on today's routine awards XP and bumps constance", async ({
    authedPage,
    seedFullOnboarding,
    api,
    testUser,
  }) => {
    await seedFullOnboarding();

    const before = await fetchUserSnapshot(api.ctx, {
      email: testUser.email,
      password: testUser.password,
    });
    expect(before.constance).toBe(0);
    expect(before.xp).toBe(0);

    await authedPage.goto("/dashboard");

    const habitRow = authedPage
      .locator("div")
      .filter({ has: authedPage.locator('input[type="checkbox"]') })
      .filter({ hasText: "Drink water" });
    const checkbox = habitRow.locator('input[type="checkbox"]').first();
    // O input do check é `sr-only` com o anel desenhado por cima (mesmo padrão
    // do desenho novo, na rotina do dashboard e na página de rotinas). Clicar no
    // input não passa o teste de alvo do Playwright — quem recebe o clique é o
    // anel, irmão dele dentro do `<label>`. Então clica-se no LABEL, que é o que
    // uma pessoa acerta.
    const checkToggle = habitRow.locator('label:has(input[type="checkbox"])').first();

    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await test.step("check the habit and wait for the backend update", async () => {
      // .click() (not .check()) — .check() asserts the DOM flips immediately,
      // but here `checked` is bound to Redux which only updates after the
      // POST /routine/check round-trip resolves. Playwright's auto-wait on
      // `toBeChecked` handles the async settle for us.
      await Promise.all([
        authedPage.waitForResponse(
          (response) =>
            response.url().endsWith("/routine/check") && response.ok(),
        ),
        checkToggle.click(),
      ]);
      await expect(checkbox).toBeChecked();
    });

    await test.step("backend records the constance + XP gain", async () => {
      const after = await fetchUserSnapshot(api.ctx, {
        email: testUser.email,
        password: testUser.password,
      });
      expect(after.constance).toBe(1);
      expect(after.xp).toBeGreaterThan(before.xp);
    });

    await test.step("reload preserves the checked state", async () => {
      await authedPage.reload();
      await expect(checkbox).toBeChecked();
    });
  });
});
