import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { DashboardPage } from "../pages/DashboardPage";
import { makeUser } from "../support/testData";
import {
  newApiContext,
  registerUser,
  loginUser,
  fetchProfile,
  editUser,
} from "../support/apiClient";

/**
 * An account must start in the language its owner is reading.
 *
 * `users.language_in_use` used to be written by the settings screen and nothing else.
 * The server reads it for every model prompt and every mail, and an empty value means
 * English there, so someone using Beyou in Portuguese got an English daily briefing, an
 * English notebook tutor and an English verification mail. Signup now carries the
 * language the screen shows, and a boot reconcile fills it in on accounts that already
 * exist, the same pair of fixes the timezone got.
 */
test.describe("Language at signup", () => {
  test("register carries the client's language, normalised to the one the app ships", async () => {
    const ctx = await newApiContext();

    for (const [claimed, stored] of [["pt-BR", "pt"], ["en", "en"]] as const) {
      const user = makeUser();
      await registerUser(ctx, { ...user, language: claimed });
      const { accessToken } = await loginUser(ctx, user);

      const profile = await fetchProfile(ctx, accessToken);
      expect(profile.languageInUse, `language stored for ${claimed}`).toBe(stored);
    }

    await ctx.dispose();
  });

  test("a language the app does not ship is dropped rather than failing the registration", async () => {
    const ctx = await newApiContext();
    const user = makeUser();

    await registerUser(ctx, { ...user, language: "fr-FR" });
    const { accessToken } = await loginUser(ctx, user);

    const profile = await fetchProfile(ctx, accessToken);
    expect(profile.languageInUse ?? "").toBe("");

    await ctx.dispose();
  });
});

test.describe("Language through the browser", () => {
  // Pinned rather than inherited from the runner. The login screen has no language
  // picker: before an account exists the app follows the browser, so the browser's
  // locale IS the choice a new user made.
  test.use({ locale: "pt-BR" });

  test("registering through the UI in Portuguese stores pt", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);

    await registerPage.goto();
    await registerPage.registerAndWaitForSuccess(user);

    const ctx = await newApiContext();
    const { accessToken } = await loginUser(ctx, user);
    const profile = await fetchProfile(ctx, accessToken);

    expect(profile.languageInUse).toBe("pt");

    await ctx.dispose();
  });

  test("an account with no saved language takes the screen's on its next boot", async ({ page }) => {
    // The path that repairs every account created before signup carried a language.
    const user = makeUser();
    const ctx = await newApiContext();

    await test.step("seed an account the old way, with no language", async () => {
      await registerUser(ctx, user);
      const { accessToken } = await loginUser(ctx, user);
      const before = await fetchProfile(ctx, accessToken);
      expect(before.languageInUse ?? "").toBe("");
    });

    await test.step("boot the app in a Portuguese browser", async () => {
      const loginPage = new LoginPage(page);
      const dashboard = new DashboardPage(page);
      await loginPage.goto();
      await loginPage.login(user);
      await dashboard.expectVisible();
    });

    await test.step("the account now says pt", async () => {
      const { accessToken } = await loginUser(ctx, user);
      await expect
        .poll(async () => (await fetchProfile(ctx, accessToken)).languageInUse, {
          message: "the reconcile is fire-and-forget, so give it a moment",
        })
        .toBe("pt");
    });

    await ctx.dispose();
  });

  test("a language the user saved is never replaced by the browser's", async ({ page }) => {
    const user = makeUser();
    const ctx = await newApiContext();

    await registerUser(ctx, user);
    const { accessToken } = await loginUser(ctx, user);
    await editUser(ctx, accessToken, { language: "en" });

    const loginPage = new LoginPage(page);
    const dashboard = new DashboardPage(page);
    await loginPage.goto();
    await loginPage.login(user);
    await dashboard.expectVisible();

    // Give a stray reconcile the same window the test above needs to see one land.
    await page.waitForTimeout(1500);
    const after = await fetchProfile(ctx, accessToken);
    expect(after.languageInUse).toBe("en");

    await ctx.dispose();
  });
});
