import { test, expect } from "../fixtures/auth";
import { createCategory, createHabit, createRoutine } from "../support/apiClient";

/**
 * The reorder of a routine's sections has been lost twice without the code changing:
 * once when the drag handle moved onto the section's icon (fixed on desktop in
 * f576004), and once on touch, where the up/down arrows sat at the BOTTOM of a section
 * that renders closed, under the items and the "add" row, while the header showed an
 * expand chevron with the same glyph as "move down". Nobody found them. The native app
 * had the identical layout and the identical report on the kanban.
 *
 * The rule this locks in: on a phone viewport, with every section closed, each section
 * shows its own pair of arrows, the ends are disabled, and pressing one changes the
 * order the PUT sends. No expanding, no hovering.
 */
test.describe("Routine section reorder on touch", () => {
  test("arrows are reachable on closed sections and reorder the PUT body", async ({
    authedPage,
    api,
  }) => {
    const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
      name: "Health",
      icon: "icon:fa-heart",
      experience: "BEGINNER",
    });
    const habit = await createHabit(api.ctx, api.accessToken, {
      name: "Stretch",
      description: "",
      motivationalPhrase: "",
      iconId: "lucide:activity",
      importance: 1,
      dificulty: 1,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    await createRoutine(api.ctx, api.accessToken, {
      name: "Day",
      iconId: "lucide:sun",
      routineSections: [
        { name: "Wake", iconId: "", startTime: "06:00", endTime: "07:00",
          habitGroup: [{ habitId: habit.id, startTime: "06:10", endTime: "06:20" }] },
        { name: "Night", iconId: "", startTime: "21:00", endTime: "22:00", habitGroup: [] },
      ],
    });

    await authedPage.setViewportSize({ width: 375, height: 812 });
    await authedPage.goto("/routines");
    // On a phone the card's actions arrive with the card open (the title is the toggle).
    await authedPage.getByRole("button", { name: /^Day / }).first().click();
    await authedPage.getByRole("button", { name: /^Edit$/ }).first().click();

    const ups = authedPage.getByRole("button", { name: "Move up" });
    const downs = authedPage.getByRole("button", { name: "Move down" });

    await test.step("both pairs are there with every section closed", async () => {
      await expect(downs).toHaveCount(2);
      await expect(authedPage.getByRole("button", { name: "Wake", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(ups.first()).toBeDisabled();
      await expect(downs.last()).toBeDisabled();
      await expect(downs.first()).toBeEnabled();
    });

    await test.step("pressing one reorders what gets saved", async () => {
      await downs.first().click();
      const [request] = await Promise.all([
        authedPage.waitForRequest((r) => r.url().includes("/routine/") && r.method() === "PUT"),
        authedPage.getByRole("button", { name: /save/i }).last().click(),
      ]);
      const body = request.postDataJSON() as { routineSections: Array<{ name: string }> };
      expect(body.routineSections.map((s) => s.name)).toEqual(["Night", "Wake"]);
    });
  });
});
