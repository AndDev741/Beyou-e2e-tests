import { test, expect } from "../fixtures/auth";
import {
  apiUrl,
  fetchDailyBriefing,
  markDailyBriefingSeen,
  newApiContext,
} from "../support/apiClient";

/**
 * The Daily Briefing: the dialog a user meets on the first dashboard open of a new day.
 *
 * The rule this file exists for is the one that would be quietly wrong forever. "Has the user
 * seen today's dialog" lives in a database column, not in each client's local storage, so that
 * closing yesterday's loose ends on a phone closes the dialog on the web too. Nothing in a unit
 * test can tell those two apart: the component behaves identically either way, and the bug only
 * appears to somebody holding two devices. It is a cross-repo contract between a controller and
 * two clients, which is what an end-to-end test is for.
 *
 * The dialog is also driven through the browser rather than asserted at the API. The point of
 * several of these cases is that a component chose the right message, and an API-level
 * assertion cannot see a screen stop rendering one.
 *
 * WHAT THIS FILE CANNOT COVER, and why it is not an oversight. The most valuable path in the
 * feature — check a forgotten habit on yesterday's snapshot and watch decayed XP land — needs a
 * snapshot for a day that has already ended. Those are written only by
 * RoutineSnapshotScheduler at local midnight, and this suite has no database access to seed one
 * and no way to move the clock. That path is covered where it can be: DailyBriefingServiceIT
 * runs the real SnapshotCheckService against real rows and asserts that the XP the dialog
 * advertises is exactly the XP the check pays, and the web and mobile component suites cover
 * the rendering and the optimistic update. If this suite ever gains a seeding hook, the case to
 * add here is that one.
 *
 * Narration is off in the e2e profile (briefing.narration-enabled: false), which is what makes
 * the feature testable at all: the endpoint still answers in full because the facts come from
 * the database, and the clients render their own translated copy where the generated lines
 * would be. A spec that waited on a live model would be slow and would depend on an upstream
 * free tier being awake.
 */

test.describe("Daily Briefing", () => {
  /**
   * The response shape, straight off the real endpoint.
   *
   * Worth an API-level case despite the UI ones below: the frontend types are hand-written
   * against this contract, and a field renamed on the server would leave every client reading
   * `undefined` while the components carried on rendering something.
   */
  test("answers with both halves, and the facts do not depend on the model", async ({
    api,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();

    const briefing = await fetchDailyBriefing(api.ctx, api.accessToken);

    // The account was created moments ago, so nothing covered yesterday. That is a real
    // answer and not an empty one: hadRoutine false means nothing was ASKED of the user,
    // which must never be rendered as a day they failed.
    expect(briefing.yesterday.hadRoutine).toBe(false);
    expect(briefing.yesterday.openItems).toEqual([]);

    // Today, on the other hand, has the seeded routine on it.
    expect(briefing.today.scheduledToday).toBe(true);
    expect(briefing.today.scheduledItemCount).toBeGreaterThan(0);

    // Narration is off for this profile, and the endpoint still answered 200 with every
    // fact. This is the whole fallback contract: the prose is the optional half.
    expect(briefing.narrative.status).toBe("PENDING");
    expect(briefing.narrative.todayLines).toEqual([]);

    expect(briefing.seenAt).toBeNull();
  });

  /**
   * An account with nothing to say gets no row and no dialog.
   *
   * A fresh account has no yesterday, no goals and no routine, so there is nothing worth
   * interrupting anybody with. This also proves no model call could ever be billed for such
   * an account: `seenAt` stays null because no row is created at all.
   */
  test("says nothing to an account that has nothing scheduled", async ({ api, briefingPage }) => {
    const briefing = await fetchDailyBriefing(api.ctx, api.accessToken);

    expect(briefing.yesterday.hadRoutine).toBe(false);
    expect(briefing.today.scheduledToday).toBe(false);
    expect(briefing.today.goalsApproaching).toEqual([]);
    expect(briefing.today.recovery).toBeNull();

    await briefingPage.goto("/dashboard");
    await expect(briefingPage).toHaveURL(/\/dashboard/);
    // Wait for the dashboard to finish its own load before asserting an absence, or the
    // assertion passes simply because nothing has rendered yet.
    await expect(briefingPage.getByTestId("dashboard-loading")).toHaveCount(0);
    await expect(briefingPage.getByTestId("daily-briefing")).toHaveCount(0);
  });

  test("opens on the dashboard when the day has something in it", async ({
    briefingPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();
    await briefingPage.goto("/dashboard");

    const dialog = briefingPage.getByTestId("daily-briefing");
    await expect(dialog).toBeVisible();

    // Yesterday is reported honestly rather than congratulated: no routine covered it.
    await expect(briefingPage.getByTestId("briefing-yesterday-empty")).toBeVisible();
    await expect(briefingPage.getByTestId("briefing-open-item")).toHaveCount(0);

    // And the informational half is on its first page.
    await expect(briefingPage.getByTestId("briefing-today-page")).toBeVisible();
  });

  /**
   * THE rule. Closing the dialog writes a column, so it stays closed on the next load — and,
   * by construction, on every other device signed into the same account.
   *
   * A localStorage implementation passes every unit test in the repo and fails this.
   */
  test("stays closed after it is dismissed, across a full reload", async ({
    api,
    briefingPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();
    await briefingPage.goto("/dashboard");
    await expect(briefingPage.getByTestId("daily-briefing")).toBeVisible();

    await briefingPage.getByTestId("briefing-done").click();
    await expect(briefingPage.getByTestId("daily-briefing")).toHaveCount(0);

    // The server now knows. This is the half a client cannot fake.
    await expect
      .poll(async () => (await fetchDailyBriefing(api.ctx, api.accessToken)).seenAt, {
        message: "seenAt should be stamped once the dialog is dismissed",
      })
      .not.toBeNull();

    // A hard reload is a fresh mount with empty component state, so anything that survives
    // it came from the server.
    await briefingPage.reload();
    await expect(briefingPage.getByTestId("briefing-today-page")).toHaveCount(0);
    await expect(briefingPage.getByTestId("daily-briefing")).toHaveCount(0);
  });

  /**
   * Acknowledging is idempotent, and the FIRST acknowledgement is the one kept.
   *
   * Re-stamping on every call would make the value useless for telling how long somebody took
   * to open the app, and it is the kind of thing a later refactor quietly changes.
   */
  test("keeps the first acknowledgement rather than the latest", async ({
    api,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();
    await fetchDailyBriefing(api.ctx, api.accessToken);

    const first = await markDailyBriefingSeen(api.ctx, api.accessToken);
    expect(first.status()).toBe(204);
    const afterFirst = await fetchDailyBriefing(api.ctx, api.accessToken);
    expect(afterFirst.seenAt).not.toBeNull();

    const second = await markDailyBriefingSeen(api.ctx, api.accessToken);
    expect(second.status()).toBe(204);
    const afterSecond = await fetchDailyBriefing(api.ctx, api.accessToken);

    expect(afterSecond.seenAt).toBe(afterFirst.seenAt);
  });

  /**
   * The tabs are the ONLY way to the second page. Nothing advances the panel on its own: the
   * prose arrives from an LLM whenever it arrives, so a timed flip would move the reader off
   * the page at exactly the moment it became worth reading.
   */
  test("the recap page is reachable from the tabs", async ({ briefingPage, seedFullOnboarding }) => {
    await seedFullOnboarding();
    await briefingPage.goto("/dashboard");
    await expect(briefingPage.getByTestId("briefing-today-page")).toBeVisible();

    await briefingPage.getByTestId("briefing-bullet-yesterday").click();

    await expect(briefingPage.getByTestId("briefing-recap-page")).toBeVisible();
    await expect(briefingPage.getByTestId("briefing-today-page")).toHaveCount(0);
  });

  /**
   * And it stays put when left alone.
   *
   * Deliberately a short, cheap wait rather than a faithful one: the removed behaviour fired
   * at thirty seconds, and a spec that waited that long to prove a negative would cost the
   * suite half a minute every run. Five seconds catches a timer reintroduced at any plausible
   * length, and the component test carries the rest.
   */
  test("does not move to the recap on its own", async ({ briefingPage, seedFullOnboarding }) => {
    await seedFullOnboarding();
    await briefingPage.goto("/dashboard");
    await expect(briefingPage.getByTestId("briefing-today-page")).toBeVisible();

    await briefingPage.waitForTimeout(5_000);

    await expect(briefingPage.getByTestId("briefing-today-page")).toBeVisible();
    await expect(briefingPage.getByTestId("briefing-recap-page")).toHaveCount(0);
  });

  /**
   * Getting it back after closing it by accident.
   *
   * The whole feature is built to stop the dialog appearing unasked, which left no way back in
   * for the one mistake it is easy to make: dismissing a modal before reading it. The
   * configuration screen asks for it, and the request has to beat the `seenAt` the dismissal
   * just wrote — while leaving that column alone, because the day WAS acknowledged and
   * clearing it would reopen the dialog on the user's other devices too.
   */
  test("can be reopened from the configuration screen after being closed", async ({
    api,
    briefingPage,
    seedFullOnboarding,
  }) => {
    await seedFullOnboarding();
    await briefingPage.goto("/dashboard");
    await briefingPage.getByTestId("briefing-done").click();
    await expect(briefingPage.getByTestId("daily-briefing")).toHaveCount(0);

    await briefingPage.goto("/configuration");
    await briefingPage.getByTestId("briefing-show-again").click();

    await expect(briefingPage).toHaveURL(/\/dashboard/);
    await expect(briefingPage.getByTestId("daily-briefing")).toBeVisible();

    // Reopening is a request to look, not an un-acknowledgement: the column stays stamped.
    expect((await fetchDailyBriefing(api.ctx, api.accessToken)).seenAt).not.toBeNull();

    // And closing it again consumes the request, so a plain reload does not bring it back.
    await briefingPage.getByTestId("briefing-done").click();
    await briefingPage.reload();
    await expect(briefingPage.getByTestId("daily-briefing")).toHaveCount(0);
  });

  /**
   * One account can never read another's morning.
   *
   * The endpoint takes no id at all, so there is nothing to tamper with — which is the point,
   * and worth a test precisely because a later "let the client name the date" convenience
   * would be the moment that stops being true.
   */
  test("is scoped to the caller", async ({ api, seedFullOnboarding }) => {
    await seedFullOnboarding();
    const mine = await fetchDailyBriefing(api.ctx, api.accessToken);

    expect(mine.today.scheduledToday).toBe(true);

    const anonymous = await newApiContext();
    const refused = await anonymous.get(`${apiUrl()}/daily-briefing`);
    expect(refused.ok()).toBeFalsy();
    await anonymous.dispose();
  });
});
