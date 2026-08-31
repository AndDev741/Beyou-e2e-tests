import { test, expect, request as playwrightRequest } from "@playwright/test";
import { apiUrl } from "../support/apiClient";

/**
 * The routing and auth boundary around federated sign-in.
 *
 * <p>What this suite CANNOT do is complete a real federated login: that needs an ID token
 * signed by a real provider, and standing up an issuer with a published JWKS inside the
 * e2e stack would be testing our fake far more than testing us. The rule about which
 * account an identity opens is covered where it lives, in
 * {@code FederatedIdentityServiceUnitTest}, including the takeover case.
 *
 * <p>What this suite DOES cover is the half a unit test cannot see, and it is the half
 * that breaks quietly: the wiring in SecurityConfig. The permitAll list there uses a
 * single-star pattern precisely so {@code /auth/oidc/<slug>/link} stays authenticated
 * while the login endpoints do not. Widening it to {@code /auth/oidc/**} — an easy and
 * plausible edit — would make the link endpoint public and nothing else in the codebase
 * would complain. That is what the first test is here to notice.
 */
test.describe("Federated sign-in wiring", () => {
  test("the link endpoint requires a session", async () => {
    const api = await playwrightRequest.newContext();

    // No cookie, no Authorization header. If this ever answers anything other than
    // 401/403, the permitAll pattern has been widened and an unauthenticated caller can
    // attach an external identity to somebody else's account.
    const response = await api.post(`${apiUrl()}/auth/oidc/omelhorsite/link`, {
      data: { idToken: "not-a-real-token" },
      failOnStatusCode: false,
    });

    expect([401, 403]).toContain(response.status());
    await api.dispose();
  });

  test("the provider list is public and answers with a list", async () => {
    const api = await playwrightRequest.newContext();

    // Public because the login screen is, and the login screen has to render before
    // anybody has a session. Empty in e2e, where no provider is configured — which is
    // itself the contract that makes the feature ship dark.
    const response = await api.get(`${apiUrl()}/auth/oidc/providers`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.providers)).toBe(true);
    await api.dispose();
  });

  test("an unconfigured provider is not found, rather than a server error", async () => {
    const api = await playwrightRequest.newContext();

    // Deleting a provider's config block is the off switch. It has to read as "no such
    // provider", not as a crash, or turning one off looks like an outage.
    const response = await api.post(`${apiUrl()}/auth/oidc/definitely-not-configured`, {
      data: { idToken: "not-a-real-token" },
      failOnStatusCode: false,
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    await api.dispose();
  });
});
