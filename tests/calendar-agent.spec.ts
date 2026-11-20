import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth";
import {
  createCalendarTask,
  editUser,
  fetchCalendarOverview,
  toggleCalendarTask,
} from "../support/apiClient";

/**
 * The assistant puts things on the calendar while the person is looking at it.
 *
 * There is no model in the e2e stack, so each turn is played back: the stream is intercepted, the
 * write the calendar tool makes goes through the same REST endpoint while the "turn" runs, and the
 * stream answers with the tool event the backend sends. What is under test is the client side of
 * the contract. A tool that reports the `calendar` domain makes the screen showing calendar data
 * read its range again (there is no calendar slice to refetch), and the chat card for a calendar
 * tool points at the Calendar, never at the routine tasks page its name also matches.
 */

/** One assistant turn as the backend streams it: one tool, then the answer. */
function playedTurn(tool: string, domains: string[], answer: string): string {
  const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event("tool", { tool, status: "started" }),
    event("tool", { tool, status: "finished", domains }),
    event("token", { text: answer }),
    event("done", {
      segments: [
        { type: "tool", tool, domains },
        { type: "text", text: answer },
      ],
    }),
  ].join("");
}

/** Today as the server sees it for this account: read back, never computed on the runner. */
async function serverToday(ctx: APIRequestContext, accessToken: string): Promise<string> {
  const probe = new Date().toISOString().slice(0, 10);
  const overview = await fetchCalendarOverview(ctx, accessToken, { from: probe, to: probe });
  return overview.today;
}

async function ask(page: Page, message: string) {
  await page.getByRole("button", { name: "Open assistant" }).click();
  await page.getByPlaceholder("Message your assistant...").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
}

/**
 * The dashboard renders every widget twice (phone carousel and desktop rail) and CSS hides one,
 * so take the visible copy (see calendar.spec.ts).
 */
function visible(page: Page, testId: string) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

test.describe("the assistant and the calendar", () => {
  test.use({ timezoneId: "UTC", viewport: { width: 1280, height: 900 } });

  test("a task the assistant adds shows on the open calendar without a reload, and its card links to the calendar", async ({
    authedPage: page,
    api,
  }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    await page.goto(`/calendar?date=${today}`);
    await expect(page.getByTestId("calendar-day-panel")).toBeVisible();
    await expect(page.getByTestId("calendar-day-panel")).not.toContainText("Call the plumber");

    await page.route("**/ai/agent/chats/*/stream", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // What createCalendarTask writes on the server while the turn runs.
      await createCalendarTask(api.ctx, api.accessToken, { title: "Call the plumber", date: today, time: "16:00" });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: playedTurn("createCalendarTask", ["calendar"], "Done, it's on your calendar for 16:00."),
      });
    });

    await ask(page, "remind me to call the plumber today at 4pm");

    // The page under the chat reads its range again; nothing reloads it.
    await expect(page.getByTestId("calendar-day-panel")).toContainText("Call the plumber");

    const panel = page.getByRole("dialog", { name: "AI Assistant" });
    await expect(panel.getByText("Added to the calendar")).toBeVisible();

    // createCalendarTask has "Task" in its name; the card must still point at the calendar.
    await expect(panel.getByRole("button", { name: "Tasks", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(page).toHaveURL(/\/calendar/);
  });

  test("a task the assistant marks done is ticked on the dashboard widget without a reload", async ({
    authedPage: page,
    api,
  }) => {
    const today = await serverToday(api.ctx, api.accessToken);
    const task = await createCalendarTask(api.ctx, api.accessToken, { title: "Pay the rent", date: today });
    await editUser(api.ctx, api.accessToken, { widgetsId: ["calendarToday"] });

    await page.goto("/dashboard");
    const toggle = visible(page, `calendar-today-toggle-${task.id}`);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await page.route("**/ai/agent/chats/*/stream", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      // What completeCalendarTask writes on the server while the turn runs.
      expect((await toggleCalendarTask(api.ctx, api.accessToken, task.id)).ok()).toBe(true);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: playedTurn("completeCalendarTask", ["calendar", "perfil"], "Marked as done. +10 XP."),
      });
    });

    await ask(page, "I paid the rent");

    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog", { name: "AI Assistant" }).getByText("Calendar task ticked or unticked"))
      .toBeVisible();
  });
});
