import { test as base, Page, APIRequestContext } from "@playwright/test";
import {
  CategoryPayload,
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
  editUser,
  loginUser,
  newApiContext,
  registerUser,
} from "../support/apiClient";
import { makeUser, TestUser } from "../support/testData";

/**
 * Tutorial bypass.
 *
 * Fresh users see the OnboardingTutorial modal until they finish or skip it.
 * For any test that isn't specifically about the tutorial we set the
 * localStorage flag the frontend uses to mean "tutorial finished" so the
 * modal never mounts. See Beyou-Frontend/src/components/tutorial/tutorialStorage.ts.
 */
const TUTORIAL_STORAGE_KEY = "beyou.tutorial.phase";
const TUTORIAL_DONE_VALUE = "done";

/**
 * Daily Briefing bypass.
 *
 * The briefing is the second thing that can put a modal over the dashboard, and it appears for
 * any account with a routine on today — which `seedFullOnboarding` creates, so most specs in
 * this suite would meet it. Like the tutorial, it is stubbed out for every test that is not
 * about it; use `briefingPage` for the ones that are.
 *
 * Stubbed at the network rather than by writing state, and that is deliberate. The real
 * "already seen" signal is a server column written by POST /daily-briefing/seen, which only
 * stamps a row that GET has already created — so a fixture-time bypass would have to run AFTER
 * a spec seeds its routine, which a fixture cannot know. Answering the GET with a briefing that
 * is already marked seen works whenever the app happens to ask.
 */
const BRIEFING_SEEN_STUB = {
  date: "1970-01-01",
  yesterday: {
    date: "1970-01-01",
    hadRoutine: false,
    complete: false,
    doneCount: 0,
    skippedCount: 0,
    xpEarned: 0,
    openItems: [],
    focusCycles: 0,
    moodLevel: null,
  },
  today: {
    scheduledItemCount: 0,
    scheduledToday: false,
    currentStreak: 0,
    bestStreak: 0,
    goalsApproaching: [],
    recovery: null,
  },
  narrative: { status: "UNAVAILABLE", todayLines: [], yesterdayLines: [] },
  seenAt: "1970-01-01T00:00:00Z",
};

export interface AuthFixtures {
  /** A page that is logged in via API + cookies, with the tutorial bypassed. */
  authedPage: Page;

  /**
   * Same as `authedPage` but with the tutorial NOT pre-completed — use this
   * to drive the onboarding flow itself.
   */
  freshAuthedPage: Page;

  /** The user created for the current test. Useful for assertions. */
  testUser: TestUser;

  /** API context bound to the backend, authenticated as testUser. */
  api: { ctx: APIRequestContext; accessToken: string };

  /**
   * Same as `authedPage` but with the Daily Briefing NOT stubbed out — use this to drive
   * the new-day dialog itself.
   */
  briefingPage: Page;

  /** Helper to seed a category for the current user via the API. */
  seedCategory: (overrides?: Partial<CategoryPayload>) => Promise<void>;

  /**
   * Seed every prerequisite the onboarding tutorial checks for, so the
   * spotlight phases auto-advance past the "create your first X" gates
   * without us having to drive each form. Produces:
   *   - 1 category
   *   - 1 habit linked to that category
   *   - 1 daily routine with 1 section containing that habit
   *   - 1 schedule for the routine that includes today
   */
  seedFullOnboarding: () => Promise<void>;
}

/**
 * `test` extends Playwright's base test with auth helpers. Use this for any
 * test that doesn't itself exercise the registration/login UI:
 *
 *   import { test, expect } from "../fixtures/auth";
 *   test("…", async ({ authedPage }) => { … });
 */
export const test = base.extend<AuthFixtures>({
  testUser: async ({}, use) => {
    await use(makeUser());
  },

  api: async ({ testUser }, use) => {
    const ctx = await newApiContext();
    await registerUser(ctx, testUser);
    const { accessToken } = await loginUser(ctx, {
      email: testUser.email,
      password: testUser.password,
    });
    await use({ ctx, accessToken });
    await ctx.dispose();
  },

  seedCategory: async ({ api }, use) => {
    const seeder = async (overrides: Partial<CategoryPayload> = {}) => {
      await createCategory(api.ctx, api.accessToken, {
        name: "Health",
        icon: "icon:fa-heart",
        description: "Seeded for E2E",
        experience: "BEGINNER",
        ...overrides,
      });
    };
    await use(seeder);
  },

  seedFullOnboarding: async ({ api }, use) => {
    const seeder = async () => {
      const { id: categoryId } = await createCategory(api.ctx, api.accessToken, {
        name: "Health",
        icon: "icon:fa-heart",
        description: "Seeded for E2E",
        experience: "BEGINNER",
      });

      const { id: habitId } = await createHabit(api.ctx, api.accessToken, {
        name: "Drink water",
        description: "Stay hydrated",
        motivationalPhrase: "Your body will thank you",
        iconId: "icon:fa-tint",
        importance: 3,
        dificulty: 1,
        categoriesId: [categoryId],
        experience: "BEGINNER",
      });

      const { id: routineId } = await createRoutine(api.ctx, api.accessToken, {
        name: "Morning routine",
        iconId: "icon:fa-sun",
        routineSections: [
          {
            name: "Wake up",
            iconId: "icon:fa-mug-hot",
            startTime: "07:00:00",
            endTime: "08:00:00",
            habitGroup: [
              {
                habitId,
                startTime: "07:00:00",
                endTime: "07:10:00",
              },
            ],
            taskGroup: [],
            favorite: false,
          },
        ],
      });

      await createSchedule(api.ctx, api.accessToken, {
        days: [currentWeekDay()],
        routineId,
      });
    };
    await use(seeder);
  },

  authedPage: async ({ browser, api }, use) => {
    const { context, page } = await buildAuthedContext(browser, api, true, true);
    await use(page);
    await context.close();
  },

  freshAuthedPage: async ({ browser, api }, use) => {
    // The briefing is stubbed here too. The tutorial suppresses it while it runs, but these
    // specs walk the tutorial to completion and then assert on the dashboard underneath.
    const { context, page } = await buildAuthedContext(browser, api, false, true);
    await use(page);
    await context.close();
  },

  briefingPage: async ({ browser, api }, use) => {
    const { context, page } = await buildAuthedContext(browser, api, true, false);
    await use(page);
    await context.close();
  },
});

/**
 * Build a Playwright browser context authenticated as the current API user.
 *
 * The backend sets a httpOnly `refreshToken` cookie on the API host. We hand
 * that exact cookie set to the browser context so the SPA's silent refresh on
 * first paint can exchange it for a fresh JWT.
 *
 * localhost:3000 (SPA) and localhost:8099 (API) are the same "site" from the
 * browser's POV, so SameSite=Lax cookies still get sent on the SPA's
 * cross-origin POST to /auth/refresh.
 *
 * @param bypassTutorial when true, marks the tutorial completed server-side
 *   (the real signal the SPA reads to clear the onboarding phase) AND pre-sets
 *   the localStorage phase so nothing flashes before the profile loads. Pass
 *   false for tests that drive the tutorial itself.
 * @param bypassBriefing when true, answers GET /daily-briefing with a briefing that is
 *   already marked seen, so the new-day dialog never mounts. Pass false for tests that
 *   drive the briefing itself. See {@link BRIEFING_SEEN_STUB}.
 */
async function buildAuthedContext(
  browser: import("@playwright/test").Browser,
  api: { ctx: APIRequestContext; accessToken: string },
  bypassTutorial: boolean,
  bypassBriefing: boolean,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  if (bypassTutorial) {
    // Mark completed via the same API the app uses — this makes the SPA clear
    // the tutorial phase on load, so no spotlight/finale mounts. (The finale
    // now renders on the "done" phase, so the old localStorage-only bypass
    // would leave a full-screen overlay covering the dashboard.)
    await editUser(api.ctx, api.accessToken, { isTutorialCompleted: true });
  }

  const storageState = await api.ctx.storageState();
  const context = await browser.newContext({
    storageState,
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  });

  if (bypassTutorial) {
    await context.addInitScript(
      ({ key, value }) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Some early page lifecycle states don't have storage yet; the
          // script runs again per-document so the flag will land before React
          // mounts.
        }
      },
      { key: TUTORIAL_STORAGE_KEY, value: TUTORIAL_DONE_VALUE },
    );
  }

  if (bypassBriefing) {
    // On the context, not the page, so it covers any page the spec opens later.
    await context.route("**/daily-briefing", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({ json: BRIEFING_SEEN_STUB });
    });
  }

  const page = await context.newPage();
  return { context, page };
}

export { expect } from "@playwright/test";
