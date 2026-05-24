import { APIRequestContext, request } from "@playwright/test";

/**
 * Thin backend client used by fixtures and tests to set up state without
 * driving the UI. Everything that is not under test (auth, seed data) goes
 * through here. UI walks stay focused on the actual user flow under test.
 *
 * All methods accept an APIRequestContext so the same client can be reused
 * across browser contexts (each test starts in a clean state).
 */

const DEFAULT_API_URL = "http://localhost:8099/api/v1";

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface CategoryPayload {
  name: string;
  icon: string;
  description?: string;
  experience: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
}

export function apiUrl(): string {
  return process.env.API_URL ?? DEFAULT_API_URL;
}

/**
 * Build a full URL against the configured API. We can't rely on Playwright's
 * baseURL resolution because Spring's context-path means our base ends in
 * `/api/v1`, and absolute-path inputs like `/auth/register` would resolve
 * against the host root instead.
 */
function joinUrl(path: string): string {
  const base = apiUrl().replace(/\/$/, "");
  const tail = path.replace(/^\//, "");
  return `${base}/${tail}`;
}

/**
 * Create an APIRequestContext bound to the backend. Caller is responsible for
 * disposing it (await ctx.dispose()) when done.
 */
export async function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: apiUrl() });
}

/**
 * Register a new user. In the `e2e` Spring profile the backend marks the
 * account as already verified, so login works immediately.
 */
export async function registerUser(
  ctx: APIRequestContext,
  payload: RegisterPayload,
): Promise<void> {
  const response = await ctx.post(joinUrl("auth/register"), { data: payload });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `register failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

/**
 * Log in and return the JWT plus the cookies (incl. httpOnly refreshToken).
 * The cookies are what we feed into a browser context so the SPA boots
 * authenticated.
 */
export async function loginUser(
  ctx: APIRequestContext,
  payload: LoginPayload,
): Promise<{ accessToken: string }> {
  const response = await ctx.post(joinUrl("auth/login"), { data: payload });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `login failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const headers = response.headers();
  const accessToken = headers["x-access-token"];
  if (!accessToken) {
    throw new Error(
      "login response missing X-Access-Token header — backend changed?",
    );
  }
  return { accessToken };
}

export interface UserSnapshot {
  xp: number;
  level: number;
  constance: number;
  maxConstance: number;
}

/**
 * Re-login the user and return a snapshot of their gamification state. Useful
 * for asserting XP / constance changes after an action driven through the UI,
 * since there is no dedicated `GET /user/me` endpoint.
 */
export async function fetchUserSnapshot(
  ctx: APIRequestContext,
  credentials: LoginPayload,
): Promise<UserSnapshot> {
  const response = await ctx.post(joinUrl("auth/login"), { data: credentials });
  if (!response.ok()) {
    throw new Error(`fetchUserSnapshot login failed: ${response.status()}`);
  }
  const body = (await response.json()) as {
    success: {
      xp: number;
      level: number;
      constance: number;
      maxConstance: number;
    };
  };
  return {
    xp: body.success.xp,
    level: body.success.level,
    constance: body.success.constance,
    maxConstance: body.success.maxConstance,
  };
}

/**
 * Create a category for the authenticated user. Habits require at least one
 * category, so tests that exercise habit flows usually seed a category first.
 *
 * The backend's POST /category response just confirms creation, so we follow
 * up with GET /category to look up the new row by name and return its id.
 */
export async function createCategory(
  ctx: APIRequestContext,
  accessToken: string,
  payload: CategoryPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("category"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createCategory failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const categories = await listCategories(ctx, accessToken);
  const match = categories.find((c) => c.name === payload.name);
  if (!match) {
    throw new Error(
      `createCategory: category named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

interface CategoryRow {
  id: string;
  name: string;
  iconId: string;
}

async function listCategories(
  ctx: APIRequestContext,
  accessToken: string,
): Promise<CategoryRow[]> {
  const response = await ctx.get(joinUrl("category"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`listCategories failed: ${response.status()}`);
  }
  return (await response.json()) as CategoryRow[];
}

export interface HabitPayload {
  name: string;
  description?: string;
  motivationalPhrase?: string;
  iconId: string;
  importance: 1 | 2 | 3 | 4 | 5;
  dificulty: 1 | 2 | 3 | 4 | 5;
  categoriesId: string[];
  experience: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
}

interface HabitRow {
  id: string;
  name: string;
}

/**
 * Create a habit and return its id. As with categories, the POST response is
 * opaque so we GET /habit to recover the id.
 */
export async function createHabit(
  ctx: APIRequestContext,
  accessToken: string,
  payload: HabitPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("habit"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createHabit failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }

  const habits = await ctx.get(joinUrl("habit"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!habits.ok()) {
    throw new Error(`listHabits failed: ${habits.status()}`);
  }
  const rows = (await habits.json()) as HabitRow[];
  const match = rows.find((h) => h.name === payload.name);
  if (!match) {
    throw new Error(
      `createHabit: habit named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

export type WeekDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface RoutineHabitGroup {
  habitId: string;
  startTime: string;
  endTime: string;
}

export interface RoutineSection {
  name: string;
  iconId: string;
  startTime: string;
  endTime: string;
  habitGroup?: RoutineHabitGroup[];
  taskGroup?: never[];
  favorite?: boolean;
}

export interface RoutinePayload {
  name: string;
  iconId: string;
  routineSections: RoutineSection[];
}

interface RoutineResponse {
  id: string;
  name: string;
}

/**
 * Create a daily routine with at least one section. Returns the routine id so
 * callers can attach a schedule.
 */
export async function createRoutine(
  ctx: APIRequestContext,
  accessToken: string,
  payload: RoutinePayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("routine"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createRoutine failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  const body = (await response.json()) as RoutineResponse;
  return { id: body.id };
}

/**
 * Attach a schedule to a routine. `days` controls which weekdays the routine
 * fires on; pass `currentWeekDay()` to make sure today is included.
 */
export async function createSchedule(
  ctx: APIRequestContext,
  accessToken: string,
  payload: { days: WeekDay[]; routineId: string },
): Promise<void> {
  const response = await ctx.post(joinUrl("schedule"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createSchedule failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
}

export interface GoalPayload {
  name: string;
  description?: string;
  iconId?: string;
  targetValue: number;
  unit: string;
  currentValue: number;
  categoriesId: string[];
  motivation?: string;
  /** ISO date string YYYY-MM-DD. */
  startDate: string;
  /** ISO date string YYYY-MM-DD. */
  endDate: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  term: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM";
}

interface GoalRow {
  id: string;
  name: string;
  currentValue: number;
  complete: boolean;
}

export async function createGoal(
  ctx: APIRequestContext,
  accessToken: string,
  payload: GoalPayload,
): Promise<{ id: string }> {
  const response = await ctx.post(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: payload,
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `createGoal failed: ${response.status()} ${response.statusText()} — ${body}`,
    );
  }
  const list = await ctx.get(joinUrl("goal"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok()) {
    throw new Error(`listGoals failed: ${list.status()}`);
  }
  const rows = (await list.json()) as GoalRow[];
  const match = rows.find((g) => g.name === payload.name);
  if (!match) {
    throw new Error(
      `createGoal: goal named "${payload.name}" not found after create`,
    );
  }
  return { id: match.id };
}

export async function increaseGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
): Promise<GoalRow> {
  const response = await ctx.put(joinUrl("goal/increase"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    // Backend takes a raw `@RequestBody UUID goalId`, which Jackson expects as
    // a JSON-encoded string ("<uuid>" with quotes). Passing the bare UUID
    // string returns 403 — Playwright sends raw bodies as-is.
    data: JSON.stringify(goalId),
  });
  if (!response.ok()) {
    throw new Error(
      `increaseGoal failed: ${response.status()} ${response.statusText()}`,
    );
  }
  return (await response.json()) as GoalRow;
}

export async function completeGoal(
  ctx: APIRequestContext,
  accessToken: string,
  goalId: string,
): Promise<{
  refreshUser: { xp: number; level: number; constance: number };
}> {
  const response = await ctx.put(joinUrl("goal/complete"), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    data: JSON.stringify(goalId),
  });
  if (!response.ok()) {
    throw new Error(
      `completeGoal failed: ${response.status()} ${response.statusText()}`,
    );
  }
  return (await response.json()) as {
    refreshUser: { xp: number; level: number; constance: number };
  };
}

/** The current local weekday in the form the backend's WeekDay enum expects. */
export function currentWeekDay(): WeekDay {
  const names: WeekDay[] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return names[new Date().getDay()];
}
