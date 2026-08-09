import { test, expect } from "../fixtures/auth";
import { createCategory, createGoal } from "../support/apiClient";

/**
 * Bug 4 — a lone goal overflows the dashboard horizontally.
 *
 * The dashboard goals widget (GoalsTab) renders each goal inside a horizontal
 * carousel: `flex overflow-x-auto flex-nowrap`, with each section
 * `flex-shrink-0` and each GoalBox forced to `readonly` (which activates
 * `min-w-[350px]`). A single goal therefore can neither wrap nor shrink, so on
 * a narrow viewport it produces a horizontal scrollbar / over-wide content even
 * though there is barely anything to show.
 *
 * This test seeds ONE goal, opens the dashboard on a phone-sized viewport, and
 * asserts the goals scroll container has no horizontal overflow. It FAILS on
 * the current build and should pass once the lone-goal layout no longer forces
 * a 350px non-shrinking card.
 */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

test.describe("Dashboard goals layout (Bug 4)", () => {
  test("a single goal does not overflow horizontally on a phone viewport", async ({
    authedPage,
    api,
  }) => {
    const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
      name: "Health",
      icon: "icon:fa-heart",
      description: "Seeded for E2E",
      experience: "BEGINNER",
    });

    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 3); // lands in a near-term goals bucket

    await createGoal(api.ctx, api.accessToken, {
      name: "Read 10 pages",
      description: "A short reading goal",
      iconId: "icon:fa-book",
      targetValue: 10,
      unit: "pages",
      currentValue: 0,
      categoriesId: [categoryId],
      startDate: isoDate(today),
      endDate: isoDate(end),
      status: "IN_PROGRESS",
      term: "SHORT_TERM",
    });

    await authedPage.setViewportSize({ width: 375, height: 812 });
    await authedPage.goto("/dashboard");

    // O bloco de metas do dashboard virou lista: cada meta é um botão com o
    // nome truncado, não mais um cartão de 350px dentro de um carrossel. O
    // nome, por isso, não é mais heading.
    const goalRow = authedPage.getByRole("button", { name: /Read 10 pages/ });
    await expect(goalRow).toBeVisible();

    // A regressão que importa continua a mesma: nada de rolagem horizontal na
    // página por causa de uma meta. Sem carrossel para medir, mede-se o
    // documento — que é onde o usuário sentiria o estouro.
    const documentOverflowPx = await authedPage.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(documentOverflowPx).toBeLessThanOrEqual(1);

    // E a linha da meta cabe na viewport (o truncate faz o serviço).
    const box = await goalRow.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1);
  });
});
