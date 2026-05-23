import { test as base, Page, APIRequestContext } from "@playwright/test";
import {
  CategoryPayload,
  createCategory,
  createHabit,
  createRoutine,
  createSchedule,
  currentWeekDay,
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
    const { context, page } = await buildAuthedContext(browser, api.ctx, true);
    await use(page);
    await context.close();
  },

  freshAuthedPage: async ({ browser, api }, use) => {
    const { context, page } = await buildAuthedContext(browser, api.ctx, false);
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
 * @param bypassTutorial when true, pre-sets localStorage so the onboarding
 *   modal never appears. Pass false for tests that drive the tutorial itself.
 */
async function buildAuthedContext(
  browser: import("@playwright/test").Browser,
  apiCtx: APIRequestContext,
  bypassTutorial: boolean,
): Promise<{ context: import("@playwright/test").BrowserContext; page: Page }> {
  const storageState = await apiCtx.storageState();
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

  const page = await context.newPage();
  return { context, page };
}

export { expect } from "@playwright/test";
