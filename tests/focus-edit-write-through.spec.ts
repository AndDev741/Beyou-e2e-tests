import { test, expect } from "../fixtures/auth";
import { HabitsPage } from "../pages/HabitsPage";
import { HabitFormPage } from "../pages/HabitFormPage";

/**
 * A rename on the habits page has to reach the focus screen through the store.
 *
 * The focus screen, like the dashboard, resolves every routine row from the habits and tasks
 * slices by id. The habits page keeps its own list and, after a save, used to refetch only
 * into that list: the persisted slice kept the old name, and the focus screen showed it until
 * its own fetch happened to land. Whether that fetch landed was luck, which is why the bug
 * read as "sometimes".
 *
 * The rule under test is that the page's refetch writes through to the store. To see the
 * store and not the fetch, `GET /habit` is cut off after the save: a focus screen that still
 * shows the new name got it from the store, because nothing else could have handed it over.
 * Before the fix this ran red with the OLD name on screen, which is the reported bug word for
 * word. The dashboard is crossed on the way in because that is the only way into focus mode,
 * and because its own failed fetch must not empty the slice either.
 */
test.describe("Focus mode and edits made elsewhere", () => {
  test("a habit renamed on its page reaches the focus screen without another fetch", async ({
    authedPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();
    const habits = new HabitsPage(authedPage);
    const form = new HabitFormPage(authedPage);
    const renamed = "Drink water, renamed";

    await test.step("the store holds the seeded name first", async () => {
      await authedPage.goto("/dashboard");
      await expect(authedPage.getByTestId("focus-enter")).toBeVisible();
      await expect(authedPage.getByText("Drink water", { exact: true })).toBeVisible();
    });

    await test.step("rename it on the habits page", async () => {
      await authedPage.getByRole("link", { name: "Habits" }).click();
      await habits.clickEdit("Drink water");
      await form.expectEditFormVisible();
      await form.nameInput().fill(renamed);
      await form.submitEdit();
      await habits.expectHabitVisible(renamed);
    });

    await test.step("from here on, nothing can fetch habits", async () => {
      await authedPage.route(
        (url) => url.pathname.endsWith("/habit"),
        (route) => (route.request().method() === "GET" ? route.abort() : route.continue()),
      );
    });

    await test.step("the focus screen shows the new name from the store", async () => {
      await authedPage.getByRole("link", { name: "Dashboard" }).click();
      await authedPage.getByTestId("focus-enter").click();

      const focusScreen = authedPage.getByTestId("focus-screen");
      await expect(focusScreen).toBeVisible();
      await expect(focusScreen.getByText(renamed)).toBeVisible();
      await expect(focusScreen.getByText("Drink water", { exact: true })).toHaveCount(0);
    });
  });
});
