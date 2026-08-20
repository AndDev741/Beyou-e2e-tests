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
 * An account must not be born on the UTC calendar.
 *
 * `users.timezone` used to be NOT NULL defaulting to 'UTC' with nothing on any signup
 * path setting it, and `UserDateResolver` keys every permanent date row off that value:
 * check days, streaks, the XP ledger, the snapshot hour, the day-close hour. In
 * Europe/Lisbon that cost an hour every summer; at a larger offset it moves the day
 * boundary by hours and stamps MISSED on days that were not over.
 *
 * Two zones on purpose. Europe/Lisbon is where Beyou runs. America/Sao_Paulo is here
 * because Lisbon is UTC+0 for five months of the year, so a Lisbon-only browser
 * assertion would pass all winter with the bug fully present.
 */
test.describe("Timezone at signup", () => {
  test("register carries the client's zone, and it comes back as DETECTED", async () => {
    const ctx = await newApiContext();

    for (const timezone of ["Europe/Lisbon", "America/Sao_Paulo"]) {
      const user = makeUser();
      await registerUser(ctx, { ...user, timezone });
      const { accessToken } = await loginUser(ctx, user);

      const profile = await fetchProfile(ctx, accessToken);
      expect(profile.timezone, `zone stored for ${timezone}`).toBe(timezone);
      expect(profile.timezoneSource).toBe("DETECTED");
    }

    await ctx.dispose();
  });

  test("a client that sends no zone still registers, on the old default", async () => {
    // The compatibility guard. An older build must not be refused, and its account has
    // to stay adoptable rather than looking like a deliberate UTC pick.
    const ctx = await newApiContext();
    const user = makeUser();

    await registerUser(ctx, user);
    const { accessToken } = await loginUser(ctx, user);

    const profile = await fetchProfile(ctx, accessToken);
    expect(profile.timezone).toBe("UTC");
    expect(profile.timezoneSource).toBe("DEFAULT");

    await ctx.dispose();
  });

  test("an unusable zone is dropped rather than failing the registration", async () => {
    const ctx = await newApiContext();
    const user = makeUser();

    await registerUser(ctx, { ...user, timezone: "Mars/Olympus" });
    const { accessToken } = await loginUser(ctx, user);

    const profile = await fetchProfile(ctx, accessToken);
    expect(profile.timezone).toBe("UTC");
    expect(profile.timezoneSource).toBe("DEFAULT");

    await ctx.dispose();
  });
});

test.describe("Timezone through the browser", () => {
  // Pinned rather than inherited from the CI runner: an assertion that depends on where
  // the machine happens to be is not an assertion.
  test.use({ timezoneId: "America/Sao_Paulo" });

  test("registering through the UI stores the browser's zone", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);

    await registerPage.goto();
    await registerPage.registerAndWaitForSuccess(user);

    const ctx = await newApiContext();
    const { accessToken } = await loginUser(ctx, user);
    const profile = await fetchProfile(ctx, accessToken);

    expect(profile.timezone).toBe("America/Sao_Paulo");
    expect(profile.timezoneSource).toBe("DETECTED");

    await ctx.dispose();
  });

  test("an account created on UTC adopts the browser's zone on its next boot", async ({ page }) => {
    // The single most valuable assertion here: this is the path that repairs every
    // account that existed before signup started carrying a zone.
    const user = makeUser();
    const ctx = await newApiContext();

    await test.step("seed an account the old way, with no zone", async () => {
      await registerUser(ctx, user);
      const { accessToken } = await loginUser(ctx, user);
      const before = await fetchProfile(ctx, accessToken);
      expect(before.timezone).toBe("UTC");
      expect(before.timezoneSource).toBe("DEFAULT");
    });

    await test.step("boot the app in a São Paulo browser", async () => {
      const loginPage = new LoginPage(page);
      const dashboard = new DashboardPage(page);
      await loginPage.goto();
      await loginPage.login(user);
      await dashboard.expectVisible();
    });

    await test.step("the account has adopted it", async () => {
      const { accessToken } = await loginUser(ctx, user);
      await expect
        .poll(async () => (await fetchProfile(ctx, accessToken)).timezone, {
          message: "the reconcile is fire-and-forget, so give it a moment",
        })
        .toBe("America/Sao_Paulo");

      const after = await fetchProfile(ctx, accessToken);
      expect(after.timezoneSource).toBe("DETECTED");
    });

    await ctx.dispose();
  });

  test("a zone the user picked is never moved by a browser that disagrees", async ({ page }) => {
    const user = makeUser();
    const ctx = await newApiContext();

    await registerUser(ctx, user);
    const { accessToken } = await loginUser(ctx, user);

    await test.step("the user picks Europe/Lisbon", async () => {
      // No timezoneSource on the request, exactly as the settings screen sends it. The
      // backend reads that as a person's choice.
      await editUser(ctx, accessToken, { timezone: "Europe/Lisbon" });
      const picked = await fetchProfile(ctx, accessToken);
      expect(picked.timezone).toBe("Europe/Lisbon");
      expect(picked.timezoneSource).toBe("EXPLICIT");
    });

    await test.step("booting in a São Paulo browser leaves it alone", async () => {
      const loginPage = new LoginPage(page);
      const dashboard = new DashboardPage(page);
      await loginPage.goto();
      await loginPage.login(user);
      await dashboard.expectVisible();

      // Nothing to wait for, so give the fire-and-forget reconcile a chance to
      // misbehave before asserting it did not.
      await page.waitForTimeout(1500);

      const after = await fetchProfile(ctx, accessToken);
      expect(after.timezone).toBe("Europe/Lisbon");
      expect(after.timezoneSource).toBe("EXPLICIT");
    });

    await ctx.dispose();
  });
});
