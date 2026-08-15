import { test, expect } from "../fixtures/auth";
import { LoginPage } from "../pages/LoginPage";
import {
  confirmAccountDeletion,
  createCategory,
  createGoal,
  createHabit,
  exportUserData,
  loginUser,
  newApiContext,
  requestAccountDeletionCode,
} from "../support/apiClient";

/**
 * Leaving BeYou for good.
 *
 * Deleting an account is the one irreversible thing the app does, so the flow asks
 * the email account to agree: BeYou mails a six-digit code and nothing is destroyed
 * until it comes back. Under the `e2e` profile the code also rides in the response
 * (`e2e.expose-deletion-code`), which is the only way a test can walk the whole
 * flow without an inbox.
 *
 * Two things are worth locking in beyond "it deletes": that a wrong code deletes
 * NOTHING, and that the account is really gone afterwards rather than merely
 * logged out. The second is asserted by trying to log back in with credentials
 * that worked a moment earlier.
 *
 * Two states this suite deliberately cannot reach, so that the gap is on the record
 * rather than merely absent:
 *
 * - `DELETION_CODE_EXPIRED` needs the 15-minute TTL to elapse. Advancing a clock is
 *   a backend integration test's job, not a browser's.
 * - The emailed code itself. Every code here comes from the response body, so the
 *   mail template, its language and the address it goes to are untested anywhere,
 *   and so is the unsent-code cleanup that only runs when the code is NOT exposed.
 *   Closing that needs a capture server (Mailpit or similar) in the dev-env compose.
 *
 * The cooldown IS reachable, but only by turning it back on: `cooldown-seconds: 0`
 * under e2e is what lets the UI walk request a second code seconds after the first.
 */

/** Never a valid code, and never the one the server generated. */
const WRONG_CODE = "000000";

test.describe("Account deletion", () => {
  test("a code from the email is what deletes the account, and nothing else does", async ({
    api,
    testUser,
  }) => {
    const { code } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    expect(code, "the e2e profile must hand the code back, or this flow cannot be tested")
      .toMatch(/^\d{6}$/);

    // Something to lose. A bare account has nothing for a half-finished deletion to
    // take, so a backend that wiped child rows before checking the code would refuse
    // with DELETION_CODE_INVALID and still look perfectly healthy from here.
    const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
      name: "Survives",
      icon: "icon:fa-heart",
      description: "Must outlive a refused code",
      experience: "BEGINNER",
    });
    await createHabit(api.ctx, api.accessToken, {
      name: "Still here",
      iconId: "lucide:droplet",
      importance: 3,
      dificulty: 2,
      categoriesId: [categoryId],
      experience: "BEGINNER",
    });
    const today = new Date();
    const oneWeekOut = new Date(today);
    oneWeekOut.setDate(today.getDate() + 7);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    await createGoal(api.ctx, api.accessToken, {
      name: "Also still here",
      description: "Must outlive a refused code",
      iconId: "icon:fa-book",
      targetValue: 10,
      unit: "pages",
      currentValue: 0,
      categoriesId: [categoryId],
      startDate: iso(today),
      endDate: iso(oneWeekOut),
      status: "IN_PROGRESS",
      term: "SHORT_TERM",
    });

    await test.step("a wrong code refuses and keeps the account", async () => {
      // Guarding against the one-in-a-million: if the server happened to generate
      // 000000, this step would delete the account it is here to protect.
      expect(code, "the wrong code must actually be wrong").not.toBe(WRONG_CODE);

      const refused = await confirmAccountDeletion(api.ctx, api.accessToken, WRONG_CODE);
      expect(refused.status()).toBe(400);
      expect(await refused.text()).toContain("DELETION_CODE_INVALID");

      // Not "the session still answers" — that passes on an empty account. Each row
      // seeded above has to still be there, one per table, so a partial wipe cannot
      // hide behind a healthy-looking response.
      const stillAlive = await exportUserData(api.ctx, api.accessToken);
      expect(stillAlive.categories as unknown[]).toHaveLength(1);
      expect(stillAlive.habits as unknown[]).toHaveLength(1);
      expect(stillAlive.goals as unknown[]).toHaveLength(1);
    });

    await test.step("the right code deletes it", async () => {
      const accepted = await confirmAccountDeletion(api.ctx, api.accessToken, code!);
      // The body, not just the status: a bare 403 says nothing, and this endpoint
      // turns an unhandled 500 into one.
      expect(accepted.status(), await accepted.text()).toBe(200);
    });

    await test.step("the account is gone, not merely signed out", async () => {
      const fresh = await newApiContext();
      await expect(
        loginUser(fresh, { email: testUser.email, password: testUser.password }),
      ).rejects.toThrow(/login failed/);
      await fresh.dispose();
    });
  });

  /**
   * Only one code is live at a time.
   *
   * The half of single-use this test used to claim — spending a code and then
   * spending it again — cannot be observed from outside: the first confirm deletes
   * the account, so the second request dies at the security filter with a dead
   * session long before it reaches the service, and the test passed whether or not
   * the code was ever invalidated. Supersession is the half that CAN be observed,
   * because the account is still there to observe it with.
   */
  test("asking for a new code kills the one before it", async ({ api }) => {
    const { code: first } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    // The e2e profile drops the cooldown, so the second request lands immediately.
    const { code: second } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    expect(first).not.toBe(second);

    const stale = await confirmAccountDeletion(api.ctx, api.accessToken, first!);
    expect(stale.status(), await stale.text()).toBe(400);
    expect(await stale.text()).toContain("DELETION_CODE_INVALID");

    // And the account it refused to delete is still there to accept the live one.
    const accepted = await confirmAccountDeletion(api.ctx, api.accessToken, second!);
    expect(accepted.status(), await accepted.text()).toBe(200);
  });

  /**
   * The cap on guessing.
   *
   * MAX_ATTEMPTS is the only thing between a six-digit code and someone walking the
   * space, and a suite that sends exactly one wrong code cannot tell a working cap
   * from an absent one. It was absent: the counter was written inside the same
   * transaction the refusal rolled back, so it never left zero, and this test is
   * what would have caught it.
   */
  test("five wrong codes close the code, and the real one dies with it", async ({ api }) => {
    const { code } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    expect(code).not.toBe(WRONG_CODE);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await confirmAccountDeletion(api.ctx, api.accessToken, WRONG_CODE);
      expect(refused.status(), `attempt ${attempt}: ${await refused.text()}`).toBe(400);
      expect(await refused.text()).toContain("DELETION_CODE_INVALID");
    }

    const capped = await confirmAccountDeletion(api.ctx, api.accessToken, WRONG_CODE);
    expect(capped.status()).toBe(400);
    expect(await capped.text()).toContain("DELETION_CODE_TOO_MANY_ATTEMPTS");

    // The code is spent as a whole, not merely locked against wrong guesses: the
    // correct digits are worthless now, and the only way forward is a new code.
    const withTheRealOne = await confirmAccountDeletion(api.ctx, api.accessToken, code!);
    expect(withTheRealOne.status(), await withTheRealOne.text()).toBe(400);
    expect(await withTheRealOne.text()).toContain("DELETION_CODE_TOO_MANY_ATTEMPTS");

    // Nothing above deleted anything.
    const stillAlive = await exportUserData(api.ctx, api.accessToken);
    expect(stillAlive.profile).toBeTruthy();
  });

  /**
   * The UI walk. The app asks for its own code when the flow starts, so the test
   * asks for another one right after — requesting a code invalidates the earlier
   * one, which makes the second the only one that works, and the e2e profile drops
   * the cooldown so the two requests can be seconds apart.
   */
  test("the danger zone walks the three steps and lands back on the login page", async ({
    authedPage,
    api,
    testUser,
    seedCategory,
  }) => {
    await seedCategory({ name: "Goes with the account" });

    await authedPage.goto("/configuration");

    await authedPage.getByTestId("delete-my-account").click();
    await expect(authedPage.getByText("Delete your account?")).toBeVisible();

    await authedPage.getByTestId("delete-account-continue").click();
    await expect(authedPage.getByTestId("delete-account-code")).toBeVisible();

    const { code } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    await authedPage.getByTestId("delete-account-code").fill(code!);
    await authedPage.getByTestId("delete-account-code-continue").click();

    // The goodbye screen, then the point of no return.
    await expect(authedPage.getByText("We'll miss you")).toBeVisible();
    await authedPage.getByTestId("delete-account-final").click();

    await authedPage.waitForURL((url) => !url.pathname.startsWith("/configuration"));
    await expect(new LoginPage(authedPage).emailInput()).toBeVisible();

    // The browser has to be emptied too, the way logout.spec.ts checks it. This
    // matters more here: a delete whose response goes missing takes the purge with
    // it unless the client treats an unclear failure as a completed one, and what
    // would be left behind belongs to an account that no longer exists.
    const persisted = await authedPage.evaluate(() => window.localStorage.getItem("persist:root"));
    if (persisted) {
      expect(persisted).not.toContain(testUser.email);
      expect(persisted).not.toContain("Goes with the account");
    }

    const fresh = await newApiContext();
    await expect(
      loginUser(fresh, { email: testUser.email, password: testUser.password }),
    ).rejects.toThrow(/login failed/);
    await fresh.dispose();
  });
});
