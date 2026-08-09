import { test, expect } from "../fixtures/auth";
import { HabitsPage } from "../pages/HabitsPage";
import { HabitFormPage } from "../pages/HabitFormPage";

/**
 * Habit CRUD covers the most common user loop:
 *   create habit → see it in the list → edit it → delete it.
 *
 * It uses the `authedPage` fixture to skip past register / login / tutorial,
 * and pre-seeds one category via the API (habits require >=1 category).
 *
 * Selectors stay semantic — form `name=` attributes, accessible button roles,
 * heading text. The only structural locator is the habit-card ancestor lookup
 * in HabitsPage (to scope Edit/Delete clicks per-card).
 */
test.describe("Habit CRUD", () => {
  test("user can create, edit, and delete a habit", async ({
    authedPage,
    seedCategory,
  }) => {
    const habitName = `Morning Run ${Date.now()}`;
    const renamed = `${habitName} (renamed)`;

    await seedCategory({ name: "Health" });

    const habits = new HabitsPage(authedPage);
    const form = new HabitFormPage(authedPage);

    await test.step("open the habits page and the create form", async () => {
      await habits.goto();
      // The form used to be inline on the page; it is now a modal behind the
      // header's button.
      await form.openCreateForm();
    });

    await test.step("create a new habit", async () => {
      await form.fill({
        name: habitName,
        description: "Run for 20 minutes",
        motivationalPhrase: "One step at a time",
        iconSearch: "running",
        importance: "Medium",
        difficulty: "Normal",
        categoryNames: ["Health"],
      });
      await form.submitCreate();
      await habits.expectHabitVisible(habitName);
    });

    await test.step("edit the habit name", async () => {
      await habits.clickEdit(habitName);
      await form.expectEditFormVisible();
      await form.nameInput().fill(renamed);
      await form.submitEdit();
      await habits.expectHabitVisible(renamed);
      await habits.expectHabitGone(habitName);
    });

    await test.step("delete the habit", async () => {
      await habits.deleteHabit(renamed);
      await habits.expectHabitGone(renamed);
    });

    // Sanity: the page is still alive — useful when a deletion silently
    // breaks something downstream (e.g. stale Redux references).
    await expect(authedPage).toHaveURL(/\/habits/);
  });
});
