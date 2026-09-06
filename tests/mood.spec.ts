import { test, expect } from "../fixtures/auth";
import { makeUser } from "../support/testData";
import {
  deleteMoodEntry,
  editUser,
  loginUser,
  registerUser,
  fetchMoodEntries,
  fetchMoodEntriesResponse,
  saveMoodEntry,
  setMoodLevel,
  todayIso,
} from "../support/apiClient";

/**
 * Daily mood and journaling, across the wire and through the browser.
 *
 * Why this file exists: the feature has one failure that cannot be recovered from, and it is not
 * a wrong number on a card. Someone writes about their day in the morning and taps a face on the
 * dashboard at night; if that tap replaces the whole entry, their writing is gone and no refetch
 * brings it back. The product avoids that structurally — the widget's route has no field to carry
 * a note in — and that is a cross-repo contract between a component and a controller, which is
 * exactly what an end-to-end test is for.
 *
 * The rest is the ordinary shape of a day: one row per day, no future days, and one account never
 * seeing another's.
 */

const yesterdayIso = (): string => {
  const date = new Date(`${todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const tomorrowIso = (): string => {
  const date = new Date(`${todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

test.describe("mood API", () => {
  test("writing the same day twice leaves one entry", async ({ api }) => {
    const today = todayIso();

    expect((await setMoodLevel(api.ctx, api.accessToken, today, 2)).ok()).toBe(true);
    expect((await setMoodLevel(api.ctx, api.accessToken, today, 5)).ok()).toBe(true);

    const entries = await fetchMoodEntries(api.ctx, api.accessToken, { from: today, to: today });
    expect(entries).toHaveLength(1);
    expect(entries[0].mood).toBe(5);
  });

  /**
   * The rule the whole two-verb split exists for, asserted where both halves are real: a Spring
   * controller and an HTTP request. A unit test can only prove the component picks PATCH; this
   * proves PATCH keeps the words.
   */
  test("setting the level does not erase what was written that day", async ({ api }) => {
    const today = todayIso();
    const written = "Slept badly, but the talk went well.";

    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 3, note: written });
    await setMoodLevel(api.ctx, api.accessToken, today, 5);

    const [entry] = await fetchMoodEntries(api.ctx, api.accessToken, { from: today, to: today });
    expect(entry.mood).toBe(5);
    expect(entry.note).toBe(written);
  });

  test("replacing the entry with no note does clear it, because that is what Save means", async ({
    api,
  }) => {
    const today = todayIso();
    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 3, note: "temporary" });

    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 3, note: null });

    const [entry] = await fetchMoodEntries(api.ctx, api.accessToken, { from: today, to: today });
    expect(entry.note).toBeNull();
  });

  test("a day that has not happened yet is refused with its own error key", async ({ api }) => {
    const response = await setMoodLevel(api.ctx, api.accessToken, tomorrowIso(), 4);

    expect(response.ok()).toBe(false);
    expect((await response.json()).errorKey).toBe("MOOD_FUTURE_DATE");
  });

  test("a level outside the scale is refused", async ({ api }) => {
    expect((await setMoodLevel(api.ctx, api.accessToken, todayIso(), 6)).ok()).toBe(false);
    expect((await setMoodLevel(api.ctx, api.accessToken, todayIso(), 0)).ok()).toBe(false);
  });

  test("past days are allowed, and come back newest first", async ({ api }) => {
    const today = todayIso();
    const yesterday = yesterdayIso();

    await setMoodLevel(api.ctx, api.accessToken, yesterday, 2);
    await setMoodLevel(api.ctx, api.accessToken, today, 4);

    const entries = await fetchMoodEntries(api.ctx, api.accessToken, { from: yesterday, to: today });
    expect(entries.map((entry) => entry.date)).toEqual([today, yesterday]);
  });

  test("the default window is the week ending today", async ({ api }) => {
    const today = todayIso();
    await setMoodLevel(api.ctx, api.accessToken, today, 3);

    const entries = await fetchMoodEntries(api.ctx, api.accessToken);

    expect(entries.some((entry) => entry.date === today)).toBe(true);
  });

  test("a window longer than the cap is refused rather than silently trimmed", async ({ api }) => {
    const today = todayIso();
    const longAgo = new Date(`${today}T00:00:00Z`);
    longAgo.setUTCDate(longAgo.getUTCDate() - 365);

    const response = await fetchMoodEntriesResponse(api.ctx, api.accessToken, {
      from: longAgo.toISOString().slice(0, 10),
      to: today,
    });

    expect(response.status()).toBe(400);
  });

  test("deleting removes the day, and deleting it twice says so", async ({ api }) => {
    const today = todayIso();
    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 1, note: "gone soon" });

    expect((await deleteMoodEntry(api.ctx, api.accessToken, today)).ok()).toBe(true);
    expect(await fetchMoodEntries(api.ctx, api.accessToken, { from: today, to: today })).toEqual([]);

    const second = await deleteMoodEntry(api.ctx, api.accessToken, today);
    expect(second.ok()).toBe(false);
    expect((await second.json()).errorKey).toBe("MOOD_NOT_FOUND");
  });

  /**
   * The diary is the most personal thing the product stores, so ownership is stated on the wire
   * with a real second account rather than inferred from the query the service happens to run.
   */
  test("one account never sees another's entries", async ({ api }) => {
    const today = todayIso();
    await saveMoodEntry(api.ctx, api.accessToken, today, { mood: 5, note: "mine alone" });

    const stranger = makeUser();
    await registerUser(api.ctx, stranger);
    const { accessToken: strangerToken } = await loginUser(api.ctx, {
      email: stranger.email,
      password: stranger.password,
    });

    expect(await fetchMoodEntries(api.ctx, strangerToken, { from: today, to: today })).toEqual([]);

    // And the stranger cannot delete what they cannot see.
    const attempt = await deleteMoodEntry(api.ctx, strangerToken, today);
    expect(attempt.ok()).toBe(false);
    const [survived] = await fetchMoodEntries(api.ctx, api.accessToken, { from: today, to: today });
    expect(survived.note).toBe("mine alone");
  });
});

test.describe("mood in the browser", () => {
  /**
   * The dashboard renders every widget TWICE — once in the phone carousel, once in the desktop
   * rail — and CSS hides whichever does not belong at the current width. `.first()` therefore
   * resolves to the hidden copy on a desktop viewport and the click waits forever on an element
   * that will never be visible. Always take the visible one.
   */
  const onDashboard = (page: import("@playwright/test").Page, testId: string) =>
    page.locator(`[data-testid="${testId}"]:visible`);

  /** The widget is opt-in, so every UI test has to turn it on first. */
  const enableWidget = async (api: { ctx: import("@playwright/test").APIRequestContext; accessToken: string }) => {
    await editUser(api.ctx, api.accessToken, { widgetsId: ["moodWeek"] });
  };

  test("marking today from the dashboard widget stores it and shows the week", async ({
    authedPage,
    api,
  }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));

    await enableWidget(api);
    await authedPage.goto("/dashboard");

    await onDashboard(authedPage, "mood-face-4").click();

    await expect(onDashboard(authedPage, "mood-week-strip")).toBeVisible();
    await expect
      .poll(async () => {
        const entries = await fetchMoodEntries(api.ctx, api.accessToken, {
          from: todayIso(),
          to: todayIso(),
        });
        return entries[0]?.mood;
      })
      .toBe(4);

    expect(errors).toEqual([]);
  });

  /**
   * The end-to-end version of the rule: real journal text typed on the page, then a real tap on
   * the dashboard widget, then the text is still there. This is the only test that exercises the
   * exact sequence a person would perform to lose their writing.
   */
  test("a tap on the dashboard widget does not delete the day's journal entry", async ({
    authedPage,
    api,
  }) => {
    const written = "Long day. Finished the thing I had been avoiding.";
    await enableWidget(api);

    await authedPage.goto("/mood");
    await authedPage.getByTestId("mood-scale-3").click();
    await authedPage.getByTestId("mood-note").fill(written);
    await authedPage.getByTestId("mood-save-note").click();

    await expect
      .poll(async () => (await fetchMoodEntries(api.ctx, api.accessToken))[0]?.note)
      .toBe(written);

    await authedPage.goto("/dashboard");
    await onDashboard(authedPage, "mood-week-today").click();
    await onDashboard(authedPage, "mood-face-5").click();

    await expect
      .poll(async () => (await fetchMoodEntries(api.ctx, api.accessToken))[0]?.mood)
      .toBe(5);
    const [entry] = await fetchMoodEntries(api.ctx, api.accessToken);
    expect(entry.note).toBe(written);
  });

  test("the diary page shows what was written, and survives a reload", async ({
    authedPage,
    api,
  }) => {
    const errors: string[] = [];
    authedPage.on("pageerror", (error) => errors.push(error.message));

    const written = "Rainy, quiet, good.";
    await saveMoodEntry(api.ctx, api.accessToken, todayIso(), { mood: 4, note: written });

    await authedPage.goto("/mood");
    await expect(authedPage.getByTestId("mood-note")).toHaveValue(written);
    await expect(authedPage.getByTestId("mood-scale-4")).toHaveAttribute("aria-pressed", "true");

    await authedPage.reload();
    await expect(authedPage.getByTestId("mood-note")).toHaveValue(written);

    expect(errors).toEqual([]);
  });

  test("a future day cannot be selected in the month calendar", async ({ authedPage, api }) => {
    await saveMoodEntry(api.ctx, api.accessToken, todayIso(), { mood: 3, note: null });

    await authedPage.goto("/mood");

    await expect(authedPage.getByTestId("mood-next-day")).toBeDisabled();
    const tomorrow = authedPage.getByTestId(`mood-day-${tomorrowIso()}`);
    if (await tomorrow.count()) {
      await expect(tomorrow).toBeDisabled();
    }
  });
});
