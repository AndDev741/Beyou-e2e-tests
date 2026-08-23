import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { makeUser } from "../support/testData";
import {
  registerUnverifiedUser,
  registerUser,
  resendVerification,
  loginUser,
} from "../support/apiClient";

/**
 * Getting back into an account whose verification mail never arrived.
 *
 * Before the resend endpoint, this was a one-way door. Login refuses an unverified
 * account, the email column is unique so registering again is refused too, and the
 * token expired after 24 hours with nothing that could issue another. The account was
 * gone and the only repair was an UPDATE by hand.
 *
 * The `e2e` profile hid the whole thing: `auto-verify-email` marks every registration
 * verified, so no spec had ever walked this path. `registerUnverifiedUser` opts one
 * account out of that shortcut and reads the token from the response, since nothing in
 * this stack reads a mailbox. Both affordances are e2e-only and prod refuses to boot
 * with them on.
 *
 * Assertions are on BEHAVIOUR, not copy: whether the account can be logged into. A
 * string assertion on the verify page would break on the next wording pass and would
 * not have told us the account was actually reachable anyway.
 *
 * Not covered here: the Google entry point, which used to walk past the verification
 * gate entirely. Its browser leg goes to Google's consent screen and its mobile leg
 * needs an ID token this suite cannot mint, so a spec at this level could only assert
 * that a rubbish token fails — which it would have done with the bug present too. That
 * one is pinned by the backend's GoogleAuthUnverifiedAccountUnitTest instead.
 */
test.describe("Verification resend", () => {
  test("a stranded account gets back in through the resend button", async ({
    page,
    request,
  }) => {
    const user = makeUser();
    const loginPage = new LoginPage(page);

    const { verificationToken: deadToken } = await registerUnverifiedUser(request, user);

    /**
     * Opens a verification link the way a person does, and waits for the call it fires.
     *
     * The page verifies from a `useEffect` on mount, so `page.goto` resolves while the
     * request is still in the air — asserting straight after it would be racing the
     * thing under test. Returns the status so the caller can say which outcome it wanted.
     */
    const openVerifyLink = async (token: string): Promise<number> => {
      const verifyCall = page.waitForResponse(r => r.url().includes("/auth/verify-email"));
      await page.goto(`/auth/verify?token=${encodeURIComponent(token)}`);
      return (await verifyCall).status();
    };

    await test.step("login is refused, and the screen offers a way out", async () => {
      await loginPage.goto();
      await loginPage.login(user);
      // The bug report in one assertion: the screen used to name the problem and stop.
      await expect(loginPage.resendVerificationButton()).toBeVisible();
    });

    // Read off the button's own response. The token normally reaches the user through
    // a mail, and there is no mailbox in this stack; asking the endpoint a second time
    // would meet the cooldown the click just started.
    let freshToken = "";

    await test.step("the button asks for a new mail", async () => {
      const resendResponse = page.waitForResponse(
        r => r.url().includes("/auth/resend-verification") && r.request().method() === "POST",
      );
      await loginPage.resendVerificationButton().click();

      const response = await resendResponse;
      expect(response.status()).toBe(200);
      freshToken = (await response.json()).verificationToken;
      expect(
        freshToken,
        "the e2e profile must hand the reissued token back (e2e.expose-verification-token)",
      ).toBeTruthy();
      expect(freshToken, "resend must mint a new token, not re-send the dead one").not.toBe(
        deadToken,
      );

      // It stops asking for the cooldown rather than sitting there looking live while
      // the backend silently refuses.
      await expect(loginPage.resendVerificationButton()).toBeDisabled();
    });

    await test.step("the link that was replaced no longer verifies anything", async () => {
      expect(await openVerifyLink(deadToken)).toBe(400);
      await expect(
        loginUser(request, { email: user.email, password: user.password }),
        "the superseded token must not verify the account — one inbox, one live link",
      ).rejects.toThrow(/EMAIL_NOT_VERIFIED/);
    });

    await test.step("the new link does, and the account is reachable again", async () => {
      expect(await openVerifyLink(freshToken)).toBe(200);

      const session = await loginUser(request, {
        email: user.email,
        password: user.password,
      });
      expect(session.accessToken).toBeTruthy();
    });
  });

  /**
   * The property that makes this endpoint safe to leave unauthenticated.
   *
   * It is easy to lose by "improving" the error reporting. The password-reset flow
   * beside it already has the leak: an unknown address gets a quiet 200, but a known
   * one inside its cooldown gets a 400 carrying PASSWORD_RESET_TOO_MANY_REQUESTS, and
   * the difference between those two answers is a way to ask which addresses are real.
   * This endpoint was modelled on that one, so the divergence needs pinning.
   *
   * The pair compared is an ALREADY-VERIFIED address against an unknown one, not a
   * cooled-down address: this profile sets the resend cooldown to zero so the spec above
   * can press the button, and under `expose-verification-token` a genuine send puts the
   * token in the body. Comparing against a live send would therefore be comparing
   * against a field that only exists in this profile, and would prove nothing about
   * production. Two addresses that must both be refused is the honest comparison, and
   * the silent-cooldown half is pinned by the backend's EmailVerificationResendTest.
   */
  test("the response cannot be asked which addresses hold an account", async ({
    request,
  }) => {
    const verified = makeUser();
    await registerUser(request, verified);   // the e2e profile verifies this one outright

    const known = await resendVerification(request, verified.email);
    const unknown = await resendVerification(
      request,
      `nobody-${crypto.randomUUID()}@beyou.local`,
    );

    expect(known.status).toBe(unknown.status);
    expect(known.body.success).toBe(unknown.body.success);
    expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
    expect(
      known.body.verificationToken,
      "a verified account must not be issued a fresh token",
    ).toBeUndefined();
  });
});
