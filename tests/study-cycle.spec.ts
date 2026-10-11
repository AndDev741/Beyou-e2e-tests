import { test, expect } from "../fixtures/auth";
import {
  createNotebookTopic,
  createStudyCycle,
  editUser,
  everyDay,
  fetchStudyCycle,
  replaceStudyBlocks,
} from "../support/apiClient";

/**
 * The study cycle through the web app: built in the editor, shown on the notebook's "Today"
 * card, fed by a logged session, and on the dashboard. The rules themselves are locked in on the
 * wire by study-cycle-rules.spec.ts; this proves the screens send what the server needs and show
 * what it answers.
 *
 * Every weekday gets minutes, so "today" has a budget whatever day and timezone the run lands on.
 */
test.describe("study cycle in the app", () => {
  test("a cycle built in the editor shows its blocks, and the notebook lays out today", async ({ authedPage: page, api }) => {
    test.setTimeout(60_000);
    await createNotebookTopic(api.ctx, api.accessToken, "Portuguese");
    await createNotebookTopic(api.ctx, api.accessToken, "Mathematics");

    await page.goto("/notebook/cycles/new");
    await expect(page.getByTestId("study-cycle-editor")).toBeVisible();
    await page.getByTestId("cycle-name").fill("Public exam");
    await page.getByTestId("cycle-add-topic").selectOption({ label: "Portuguese" });
    await page.getByTestId("cycle-add-topic").selectOption({ label: "Mathematics" });
    await expect(page.getByTestId("cycle-topic-row")).toHaveCount(2);

    // Sunday starts as a rest day in a new cycle; give it the same 90 minutes as the weekdays.
    const sunday = page.getByTestId("cycle-day").nth(6);
    for (let i = 0; i < 3; i++) await sunday.getByRole("button").last().click();
    await expect(sunday.getByTestId("cycle-day-minutes")).toContainText("1h30");

    // Portuguese matters more: its share of the week, and so its blocks, grow.
    const portuguese = page.getByTestId("cycle-topic-row").filter({ hasText: "Portuguese" });
    await portuguese.getByTestId("topic-importance-up").click();
    await portuguese.getByTestId("topic-importance-up").click();
    await expect(page.getByTestId("cycle-plan-block").first()).toContainText("Portuguese");
    const planned = await page.getByTestId("cycle-plan-block").count();
    expect(planned).toBeGreaterThan(2);

    await page.getByTestId("cycle-save").click();
    await expect(page).toHaveURL(/\/notebook\/cycles\?cycle=/);
    await expect(page.getByTestId("cycle-block")).toHaveCount(planned);

    await page.goto("/notebook");
    const card = page.getByTestId("study-today-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("study-today-cycle")).toContainText("Public exam");
    await expect(card.getByTestId("study-today-entry").first()).toContainText("Portuguese");
  });

  test("a session logged from the Today card lands on the topic's first open block", async ({ authedPage: page, api }) => {
    const portuguese = await createNotebookTopic(api.ctx, api.accessToken, "Portuguese");
    const maths = await createNotebookTopic(api.ctx, api.accessToken, "Mathematics");
    const cycle = await createStudyCycle(api.ctx, api.accessToken, {
      name: "Public exam",
      defaultMode: "TIME",
      maxBlockMinutes: 90,
      days: everyDay(120),
      topics: [portuguese.id, maths.id].map((topicId) => ({ topicId, importance: 3, mastery: 3, minutesOverride: null })),
    });
    const block = (topicId: string) => ({
      id: null, topicId, mode: "TIME" as const, plannedMinutes: 60, goalSource: null, pageId: null, requireQuiz: false, note: null,
    });
    await replaceStudyBlocks(api.ctx, api.accessToken, cycle.id, [block(maths.id), block(portuguese.id)]);

    await page.goto("/notebook");
    await page.getByTestId("study-today-log").click();
    const dialog = page.getByTestId("log-session-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("log-session-topic").selectOption({ label: "Portuguese" });
    await dialog.getByTestId("log-session-minutes").fill("45");
    // The dialog says where the minutes go before anything is sent: Portuguese's block, the second.
    await expect(dialog.getByTestId("log-session-preview")).toContainText("2");
    await dialog.getByTestId("log-session-submit").click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await fetchStudyCycle(api.ctx, api.accessToken, cycle.id)).blocks.map((b) => b.progress.minutes))
      .toEqual([0, 45]);
    // The card reads the cycle again and shows the block moving.
    await expect(page.getByTestId("study-today-entry").filter({ hasText: "Portuguese" })).toContainText("15");
  });

  test("the dashboard widget shows what is up next today", async ({ authedPage: page, api }) => {
    const history = await createNotebookTopic(api.ctx, api.accessToken, "History");
    await createStudyCycle(api.ctx, api.accessToken, {
      name: "University",
      defaultMode: "TIME",
      maxBlockMinutes: 90,
      days: everyDay(60, "19:00"),
      topics: [{ topicId: history.id, importance: 3, mastery: 3, minutesOverride: null }],
    });
    await editUser(api.ctx, api.accessToken, { widgetsId: ["studyToday"] });

    await page.goto("/dashboard");
    // The dashboard mounts its widgets for both layouts; the one in view is the one that counts.
    const widget = page.locator('[data-testid="study-today-widget"]:visible');
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("History");
    await expect(widget).toContainText("19:00");
  });
});
