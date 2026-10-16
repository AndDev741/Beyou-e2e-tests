import { test, expect } from "../fixtures/auth";
import { addNotebookNode, createNotebookTopic, createStudyCycle, everyDay, fetchStudyToday } from "../support/apiClient";

/**
 * A pomodoro started on a notebook page counts for the study cycle, and the block shows it.
 *
 * The server always credited it. What looked broken was the screen: a concept block's bar
 * followed its page's status, so after 25 minutes on a page not yet started the bar stayed empty
 * and the minutes only showed in small print. The rule specs drive the credit through the API;
 * this one goes through the page's Focus button, the timer and the "Today" card, because the bug
 * lived between them.
 */
test.describe("study cycle focus", () => {
  test("a pomodoro on a page deep inside a subject fills its block's bar", async ({ authedPage: page, api }) => {
    test.setTimeout(90_000);
    // The subject is a page inside the topic and the pomodoro runs two levels below it, the way
    // a real roadmap nests, so the credit has to walk the home chain up to the subject.
    const topic = await createNotebookTopic(api.ctx, api.accessToken, "Software Engineer");
    const subject = await addNotebookNode(api.ctx, api.accessToken, topic.id, "Systems Engineering");
    const basics = await addNotebookNode(api.ctx, api.accessToken, subject.pageId!, "Technical basics");
    const acid = await addNotebookNode(api.ctx, api.accessToken, basics.pageId!, "Transactions (ACID)");
    await createStudyCycle(api.ctx, api.accessToken, {
      name: "Senior engineer", defaultMode: "GOAL", maxBlockMinutes: 90, days: everyDay(60),
      topics: [{ topicId: subject.pageId!, importance: 3, mastery: 3, minutesOverride: null }],
    });

    // A fake clock, so the 25 minutes pass in a moment.
    await page.clock.install();

    await test.step("start Focus 25 on the page and let it run out", async () => {
      await page.goto(`/notebook/${acid.pageId}`);
      await expect(page.getByTestId("page-title")).toHaveValue("Transactions (ACID)");
      await page.getByTestId("page-focus").click();
      await expect(page.getByTestId("page-focus")).toBeDisabled();

      const recorded = page.waitForResponse((r) => r.url().endsWith("/focus/cycles") && r.request().method() === "POST");
      await page.clock.fastForward("25:05");
      const response = await recorded;
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.kind).toBe("POMODORO");
      expect(body.notebookPageId).toBe(acid.pageId);
    });

    await test.step("the block holds the minutes and its bar shows them", async () => {
      const today = await fetchStudyToday(api.ctx, api.accessToken);
      const entry = today.cycles[0].entries[0];
      expect(entry.credited).toBe(25);
      const planned = entry.plannedMinutes;

      await page.goto("/notebook");
      const block = page.getByTestId("study-today-entry").first();
      await expect(block).toContainText("Transactions (ACID)");
      await expect(block.getByTestId("block-figure")).toContainText("25 min");
      // The page is still not started; before the fix this bar was at 0%.
      await expect(block.getByTestId("block-figure-bar"))
        .toHaveAttribute("style", new RegExp(`width: ${Math.round((25 / planned) * 100)}%`));
    });
  });
});
