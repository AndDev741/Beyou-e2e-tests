import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import { createGoal, type GoalPayload } from "../support/apiClient";

/**
 * Coming back to the tab must not wipe a form the person was halfway through.
 *
 * The pages keep themselves current: switching back to the tab (a window `focus` or a
 * `visibilitychange`) refetches the page's list and dispatches it into Redux. That is on
 * purpose and stays. What broke is a form that re-seeded itself from the list it depends on:
 * the create-goal form opened from a card's "Add sub-goal" ran `reset()` whenever the parent
 * goal object changed identity, and every refetch hands out new objects. So the kanban card
 * "Trocar de tab limpa formulário de criação de metas": type a name, check another tab, come
 * back, and the form was empty.
 *
 * "Verificar com outros": the other create forms get the same treatment here, so the next form
 * that seeds itself from a list cannot quietly do the same.
 *
 * The refresh is triggered the way the hook hears it, a window `focus` event, and the spec
 * waits for the list's GET to land before reading the field. Without that wait a passing run
 * would only prove the check ran before the refetch did.
 */

// Wide enough for the card's hover actions (Add sub-goal lives there on desktop).
test.use({ viewport: { width: 1280, height: 900 } });

const iso = (d: Date) => d.toISOString().slice(0, 10);

function goalPayload(name: string): GoalPayload {
  const today = new Date();
  const out = new Date(today);
  out.setDate(today.getDate() + 60);
  return {
    name,
    iconId: "icon:fa-flag",
    targetValue: 10,
    unit: "km",
    currentValue: 0,
    categoriesId: [],
    startDate: iso(today),
    endDate: iso(out),
    status: "NOT_STARTED",
    term: "MEDIUM_TERM",
    parentId: null,
  };
}

/** What useAutoRefresh listens for, then the refetch it causes. */
async function comeBackToTheTab(page: Page, listPath: string): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith(listPath) && r.request().method() === "GET" && r.ok(),
    ),
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);
  // One frame for the dispatch to reach the form.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

test.describe("a half-filled form survives the page refreshing itself", () => {
  test("create goal", async ({ authedPage }) => {
    await authedPage.goto("/goals");
    await authedPage.getByTestId("create-goal").click();
    const form = authedPage.locator("form:visible");
    await form.locator("#goal-title").fill("Run a half marathon");
    await form.getByLabel("Unit").fill("km");

    await comeBackToTheTab(authedPage, "/goal");

    await expect(form.locator("#goal-title")).toHaveValue("Run a half marathon");
    await expect(form.getByLabel("Unit")).toHaveValue("km");
  });

  test("create sub-goal, opened from the parent's card", async ({ authedPage, api }) => {
    // The path the card was about: the form borrows the parent's categories and end date, and
    // that borrowing is what re-ran on every refetch.
    const { id: parent } = await createGoal(api.ctx, api.accessToken, goalPayload("Get fit"));

    await authedPage.goto("/goals");
    await authedPage.locator(`#goal-${parent}`).hover();
    await authedPage.getByTestId(`add-subgoal-${parent}`).click();
    await authedPage.getByTestId("add-subgoal-create").click();
    const form = authedPage.locator("form:visible");
    await expect(form.getByTestId("goal-parent")).toHaveValue(parent);
    await form.locator("#goal-title").fill("Run a half marathon");
    await form.getByLabel("Unit").fill("km");

    await comeBackToTheTab(authedPage, "/goal");

    await expect(form.locator("#goal-title")).toHaveValue("Run a half marathon");
    await expect(form.getByLabel("Unit")).toHaveValue("km");
    // And the parent it was opened for is still the one selected.
    await expect(form.getByTestId("goal-parent")).toHaveValue(parent);
  });

  for (const page of [
    { name: "create habit", path: "/habits", open: "create-habit", field: "#habit-name", list: "/habit" },
    { name: "create task", path: "/tasks", open: "create-task", field: "#task-name", list: "/task" },
    {
      name: "create category",
      path: "/categories",
      open: "create-category",
      field: "#category-name",
      list: "/category",
    },
  ]) {
    test(page.name, async ({ authedPage }) => {
      await authedPage.goto(page.path);
      await authedPage.getByTestId(page.open).click();
      const field = authedPage.locator(`${page.field}:visible`);
      await field.fill("Something half-typed");

      await comeBackToTheTab(authedPage, page.list);

      await expect(field).toHaveValue("Something half-typed");
    });
  }
});
