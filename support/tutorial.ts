import { expect, Page } from "@playwright/test";

/**
 * The titles of the intro cards, in order, as the English UI renders them.
 *
 * One list for every spec that walks the intro, so adding a card means editing one line
 * here instead of hunting for every `for (let i = 0; i < N; i++)` that counted Next clicks.
 */
export const INTRO_CARD_TITLES = [
  "Start with Categories",
  "Create Your Habits",
  "Add One-Time Tasks",
  "Build Your Routines",
  "Set Your Goals",
  "Keep a Diary",
  "Study in the Notebook",
] as const;

/**
 * Clicks through every intro card and presses "Get Started", which opens the fork.
 *
 * Asserts each card's title on the way, so a card that disappears or moves fails here
 * with its name rather than as a missing "Get Started" button three clicks later.
 */
export async function walkIntroCards(page: Page): Promise<void> {
  const next = page.getByRole("button", { name: "Next" });
  for (let i = 0; i < INTRO_CARD_TITLES.length; i++) {
    await expect(
      page.getByRole("heading", { name: INTRO_CARD_TITLES[i], exact: true }),
    ).toBeVisible();
    if (i < INTRO_CARD_TITLES.length - 1) {
      await next.click();
    }
  }
  await page.getByRole("button", { name: "Get Started" }).click();
}
