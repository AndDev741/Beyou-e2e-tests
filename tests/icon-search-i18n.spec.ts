import { expect, Locator, Page } from "@playwright/test";
import { test as authed } from "../fixtures/auth";
import { fetchHabits } from "../support/apiClient";

/**
 * Icon search in Portuguese.
 *
 * A user reported that icons and emoji could only be searched in English, and that
 * some were missing outright — "bíblia" and "cruz" among them. The cross was in the
 * catalogue the whole time; it was simply unreachable, because Portuguese support was
 * a 17-word alias list and every other word returned an empty grid.
 *
 * This has to be driven through the browser. The translated vocabulary lives in
 * `@beyou/icons`, but what makes it a fix is that the picker feeds it the user's
 * locale and hands the chosen id to the form — an API-level test never goes through
 * the screen and so cannot see either half stop working.
 *
 * Portuguese is forced with `?lng=pt`: `i18next-browser-languagedetector` reads the
 * querystring first, ahead of localStorage and the browser's own language, so the
 * locale is pinned rather than inherited from whatever the runner happens to be set
 * to. The tile labels stay English (they are the icon's own name, not UI copy), which
 * is exactly what makes these assertions meaningful: a Portuguese query has to land
 * on an English-named icon.
 */

const CREATE_HABIT = "create-habit";

/** The picker's search box inside the visible form. Locale-independent. */
const iconSearch = (page: Page): Locator =>
  page.locator('form:visible input[name="icon-small"]');

/** Every icon tile, in the order the picker ranked them. */
const iconTiles = (page: Page): Locator =>
  page.locator('form:visible button[aria-label^="Ícone:"]');

async function openHabitFormInPortuguese(page: Page): Promise<void> {
  await page.goto("/habits?lng=pt");
  await page.getByTestId(CREATE_HABIT).click();
  // The heading is translated, so wait on the form itself.
  await expect(page.locator("form:visible")).toBeVisible();
  // The label proves the locale actually applied before anything is asserted.
  await expect(page.locator('form:visible label[for="icon-small"]')).toHaveText("Ícone");
}

async function search(page: Page, query: string): Promise<void> {
  await iconSearch(page).fill(query);
  // The grid re-renders synchronously off the query; wait for a settled first tile
  // rather than a fixed pause.
  await expect(iconTiles(page).first()).toBeVisible();
}

authed.describe("icon search in Portuguese", () => {
  authed("finds the faith icons the report asked for", async ({ authedPage, seedCategory }) => {
    await seedCategory({ name: "Fé" });
    await openHabitFormInPortuguese(authedPage);

    await authed.step('"cruz" leads with the cross', async () => {
      await search(authedPage, "cruz");
      await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", "Ícone: cross");
    });

    await authed.step('"igreja" leads with the church', async () => {
      await search(authedPage, "igreja");
      await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", "Ícone: church");
    });

    await authed.step('"bíblia" answers with a book, accents and all', async () => {
      await search(authedPage, "bíblia");
      // No bible glyph exists in lucide or the emoji set, so a book stands in. What
      // matters is that the query answers at all — it used to return nothing.
      await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", /book/);
      const unaccented = iconTiles(authedPage).first();
      await search(authedPage, "biblia");
      await expect(unaccented).toBeVisible();
    });

    await authed.step('"oração" leads with praying hands', async () => {
      await search(authedPage, "oração");
      await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", "Ícone: pray");
    });
  });

  authed("finds everyday Portuguese words that used to return nothing", async ({
    authedPage,
    seedCategory,
  }) => {
    await seedCategory({ name: "Saúde" });
    await openHabitFormInPortuguese(authedPage);

    const cases: Array<[string, RegExp]> = [
      ["academia", /dumbbell|biceps|muscle/],
      ["água", /droplet|glass water|potable/],
      ["dormir", /bed|sleeping|moon/],
      ["correr", /footprints|runner/],
      ["dinheiro", /banknote|dollar|coins|moneybag/],
      ["dente", /tooth/],
      ["cachorro", /dog|paw/],
    ];

    for (const [query, expected] of cases) {
      await authed.step(`"${query}"`, async () => {
        await search(authedPage, query);
        await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", expected);
      });
    }
  });

  authed("a Portuguese word inside an unrelated one no longer matches everything", async ({
    authedPage,
    seedCategory,
  }) => {
    await seedCategory({ name: "Comida" });
    await openHabitFormInPortuguese(authedPage);

    // "bolo" (cake) sits inside "simbolo", a keyword every entry used to carry, so it
    // matched the whole catalogue and the grid opened on a-arrow-down.
    await search(authedPage, "bolo");
    await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-label", "Ícone: cake");
    expect(await iconTiles(authedPage).count()).toBeLessThan(6);
  });

  authed("browses by category without typing anything", async ({ authedPage, seedCategory }) => {
    await seedCategory({ name: "Fé" });
    await openHabitFormInPortuguese(authedPage);

    // The domain categories sit behind "Mais categorias" so the compact picker keeps
    // one chip row until someone asks for more.
    const form = authedPage.locator("form:visible");
    await form.getByRole("button", { name: "Mais categorias" }).click();
    await form.getByRole("button", { name: "Fé", exact: true }).click();

    await expect(iconTiles(authedPage).first()).toBeVisible();
    const labels = await iconTiles(authedPage).evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("aria-label") ?? ""),
    );
    expect(labels.join(" ")).toMatch(/church|cross|pray/);
  });

  authed("the id a Portuguese search picks is the id that gets saved", async ({
    authedPage,
    seedCategory,
    api,
  }) => {
    // The whole point of the picker is what it hands the form. Searching in
    // Portuguese has to end with `lucide:cross` on the habit, not a fallback.
    await seedCategory({ name: "Fé" });
    await openHabitFormInPortuguese(authedPage);

    const habitName = `Ler a Bíblia ${Date.now()}`;
    const form = authedPage.locator("form:visible");

    await form.locator("#habit-name").fill(habitName);
    await form.locator("#habit-description").fill("Todos os dias, de manhã");

    await search(authedPage, "cruz");
    await iconTiles(authedPage).first().click();
    await expect(iconTiles(authedPage).first()).toHaveAttribute("aria-pressed", "true");

    await form.getByRole("checkbox", { name: "Fé" }).check();

    // Importance and difficulty are required; the form silently stays open without
    // them. Pick by position inside each translated group rather than by the option
    // labels, which are also translated.
    await form.getByRole("radiogroup", { name: "Importância" }).getByRole("radio").nth(1).click();
    await form.getByRole("radiogroup", { name: "Dificuldade" }).getByRole("radio").nth(1).click();

    // The submit label is translated; the attribute is not.
    await form.locator('button[type="submit"]').click();

    await expect(
      authedPage.getByRole("heading", { level: 2, name: habitName, exact: true }),
    ).toBeVisible();

    const habits = await fetchHabits(api.ctx, api.accessToken);
    const created = habits.find((h) => h.name === habitName);
    expect(created, "the habit should exist").toBeTruthy();
    expect(created?.iconId).toBe("lucide:cross");
  });
});
