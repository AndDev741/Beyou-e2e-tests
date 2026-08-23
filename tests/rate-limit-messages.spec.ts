import { test as authTest, expect } from "../fixtures/auth";
import { test as base } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { RegisterPage } from "../pages/RegisterPage";
import { makeUser } from "../support/testData";

/**
 * What a throttled user is told.
 *
 * The rate limiter is switched off in the e2e profile (`rate-limit.enabled: false`),
 * so these specs stub the 429 at the network layer using the exact response the
 * filter really sends — status, `Retry-After`, and the JSON body with its errorKey.
 * The point under test is not the limiter, which has its own unit tests; it is what
 * the screen does with that answer, which is why both run through the real UI.
 *
 * Both messages were wrong in different ways. A throttled login claimed the password
 * was incorrect, sending people back to retype a password that was right and spend
 * what was left of the 5-per-15-minutes bucket. A throttled chat said "an unexpected
 * error occurred", because the SSE stream rides raw fetch and never meets the
 * interceptor that handles 429 everywhere else — the correct sentence was sitting
 * translated in both languages, unused.
 */

const TOO_MANY = {
  status: 429,
  headers: { "Retry-After": "118" },
  contentType: "application/json",
  body: JSON.stringify({
    errorKey: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests. Retry after 118 seconds.",
  }),
};

base.describe("A throttled sign-in names the throttle", () => {
  base("login says too many requests, not wrong password", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);
    const loginPage = new LoginPage(page);

    await registerPage.goto();
    await registerPage.registerAndWaitForSuccess(user);

    // Only the login POST is stubbed; the page itself is the real app.
    await page.route("**/auth/login", (route) =>
      route.request().method() === "POST" ? route.fulfill(TOO_MANY) : route.continue(),
    );

    await loginPage.goto();
    await loginPage.login({ email: user.email, password: user.password });

    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Too many requests. Please wait a moment and try again." }),
    ).toBeVisible();
    // The claim that must not appear: their password was in fact correct.
    await expect(
      page.getByRole("alert").filter({ hasText: "Wrong email or password" }),
    ).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  base("register says too many requests, not email already in use", async ({ page }) => {
    const user = makeUser();
    const registerPage = new RegisterPage(page);

    await page.route("**/auth/register", (route) =>
      route.request().method() === "POST" ? route.fulfill(TOO_MANY) : route.continue(),
    );

    await registerPage.goto();
    await registerPage.fill(user);
    await registerPage.submit();

    await expect(
      page.getByText("Too many requests. Please wait a moment and try again."),
    ).toBeVisible();
    // A brand-new address: telling this visitor it is taken would be false.
    await expect(page.getByText("Email already in use")).toHaveCount(0);
  });
});

authTest.describe("A throttled assistant names the throttle", () => {
  authTest("the chat reports the rate limit, not an unexpected error", async ({
    authedPage: page,
  }) => {
    // The agent FAB only appears once the tutorial is complete, which authedPage does.
    await page.goto("/dashboard");

    await page.route("**/ai/agent/chats/*/stream", (route) =>
      route.request().method() === "POST" ? route.fulfill(TOO_MANY) : route.continue(),
    );

    await page.getByRole("button", { name: "Open assistant" }).click();
    await expect(page.getByRole("dialog", { name: "AI Assistant" })).toBeVisible();

    await page.getByPlaceholder("Message your assistant...").fill("plan my morning");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Too many requests. Please wait a moment and try again." }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "An unexpected error occurred" }),
    ).toHaveCount(0);
  });
});
