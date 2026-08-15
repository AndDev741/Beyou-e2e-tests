import { test, expect } from "../fixtures/auth";
import { LoginPage } from "../pages/LoginPage";
import {
  confirmAccountDeletion,
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
 */
test.describe("Account deletion", () => {
  test("a code from the email is what deletes the account, and nothing else does", async ({
    api,
    testUser,
  }) => {
    const { code } = await requestAccountDeletionCode(api.ctx, api.accessToken);
    expect(code, "the e2e profile must hand the code back, or this flow cannot be tested")
      .toMatch(/^\d{6}$/);

    await test.step("a wrong code refuses and keeps the account", async () => {
      const refused = await confirmAccountDeletion(api.ctx, api.accessToken, "000000");
      expect(refused.status()).toBe(400);
      expect(await refused.text()).toContain("DELETION_CODE_INVALID");

      // Still there: the session works and still answers with the user's data.
      const stillAlive = await exportUserData(api.ctx, api.accessToken);
      expect(stillAlive).toBeTruthy();
    });

    await test.step("the right code deletes it", async () => {
      const accepted = await confirmAccountDeletion(api.ctx, api.accessToken, code!);
      expect(accepted.status()).toBe(200);
    });

    await test.step("the account is gone, not merely signed out", async () => {
      const fresh = await newApiContext();
      await expect(
        loginUser(fresh, { email: testUser.email, password: testUser.password }),
      ).rejects.toThrow(/login failed/);
      await fresh.dispose();
    });
  });

  test("a spent code cannot be spent twice", async ({ api }) => {
    const { code } = await requestAccountDeletionCode(api.ctx, api.accessToken);

    const first = await confirmAccountDeletion(api.ctx, api.accessToken, code!);
    expect(first.status()).toBe(200);

    // The account is gone, so the session behind this call is too. Whatever the
    // second attempt answers, it must not be a success.
    const second = await confirmAccountDeletion(api.ctx, api.accessToken, code!);
    expect(second.ok()).toBe(false);
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
  }) => {
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

    const fresh = await newApiContext();
    await expect(
      loginUser(fresh, { email: testUser.email, password: testUser.password }),
    ).rejects.toThrow(/login failed/);
    await fresh.dispose();
  });
});
