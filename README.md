# Beyou E2E Tests

End-to-end tests for the Beyou stack using [Playwright](https://playwright.dev).

These tests drive a real browser against a real backend connected to a real
PostgreSQL database. If a test passes, a user could realistically do that
flow against the deployed app.

## Project layout

```
Beyou-e2e-tests/
├── playwright.config.ts   # browsers, retries, baseURL, reporters
├── tests/                 # *.spec.ts files
├── pages/                 # Page Object Model (LoginPage, DashboardPage, ...)
├── fixtures/              # reusable test contexts (auth, seeded data) — added in Phase 2
└── support/               # helpers: testData factories, API client (later)
```

## What's covered

| Spec | What it proves |
|------|----------------|
| `tests/auth.spec.ts` | Register → log in → reach the dashboard (full UI) |
| `tests/auth-persistence.spec.ts` | Logged-in user survives a hard reload; silent refresh works on first paint |
| `tests/auth-failures.spec.ts` | Wrong password, unknown email (no enumeration), weak password, invalid email — locked-in error UX |
| `tests/logout.spec.ts` | Logout invalidates the session, purges PII from redux-persist, blocks `/dashboard` for unauthed users, lets the same creds log back in |
| `tests/habits.spec.ts` | Create → edit → delete a habit through the UI |
| `tests/goals.spec.ts` | API-only: `/goal/increase` awards no XP, `/goal/complete` does — locks in the asymmetry. Also that increase/decrease move by the amount they are given and that progress is what starts a goal |
| `tests/routine-checkin.spec.ts` | Check a habit on today's routine → XP and constance go up; checkbox state survives a reload |
| `tests/tutorial.spec.ts` | Skip, walk the 5-step intro, **and** walk the whole onboarding journey end to end (intro → dashboard → categories → habits → routines → config) |

Everything except `auth.spec.ts`, `auth-persistence.spec.ts`, and
`auth-failures.spec.ts` uses `fixtures/auth.ts` to set up an authenticated
browser context without driving the auth UI for every test — fast, hermetic,
and lets each spec focus on the flow under test.

## Prerequisites

1. **Node.js 20+**
2. **A running stack** — backend on `:8099`, frontend on `:3000`, Postgres reachable
3. **A dedicated `beyou_e2e` database** — see "Database setup" below
4. **Backend started with the `e2e` profile** so registration auto-verifies
   emails (no SMTP needed) and rate limiting is off

## ⚠️ Database setup (critical, do this once)

The `e2e` profile uses `ddl-auto: create-drop` — every backend boot **wipes the
schema and rebuilds it**. If you point this at your dev `beyou` database, you
will lose all your dev data.

**A safety check (`E2eSafetyCheck.java`) refuses to start the backend in the
`e2e` profile unless the JDBC URL contains `e2e` or `test`** — but the right
fix is still a separate database.

Create it once:

```bash
# If your Postgres is in Docker (the dev-env stack):
docker exec -it $(docker ps --filter "name=db" --format "{{.ID}}") \
  psql -U postgres -c "CREATE DATABASE beyou_e2e;"

# If you run Postgres natively:
psql -U postgres -c "CREATE DATABASE beyou_e2e;"
```

The `e2e` profile defaults to `jdbc:postgresql://localhost:5490/beyou_e2e`.
Override via the `DATABASE_URL` env var if you want a different host/port,
but the database name must contain `e2e` or `test` — anything else and the
backend refuses to start.

## Setup (first time only)

```bash
cd Beyou-e2e-tests
npm install
npx playwright install --with-deps    # downloads browser binaries
```

## Running locally

### 1. Start the database

```bash
cd ../Beyou-dev-env
./scripts/up-dev.sh         # or your usual local stack script
```

### 2. Start the backend in `e2e` profile

```bash
cd ../Beyou-backend-spring
SPRING_PROFILES_ACTIVE=e2e ./mvnw spring-boot:run
```

Key thing: the `e2e` profile auto-verifies users on registration so the test
does not need to read an email. It also disables rate limiting and uses a
noop SMTP config. See `application-e2e.yml`.

### 3. Start the frontend pointing at that backend

```bash
cd ../Beyou-Frontend
VITE_API_URL=http://localhost:8099/api/v1 npm run dev
```

### 4. Run the tests

```bash
cd ../Beyou-e2e-tests
npm test                    # headless run, all specs
npm run test:headed         # see the browser
npm run test:ui             # interactive Playwright UI mode
npm run test:debug          # step through with the Playwright inspector

# Run a single spec
npx playwright test tests/habits.spec.ts
npx playwright test tests/tutorial.spec.ts
npx playwright test tests/auth.spec.ts

# Run a single test by name
npx playwright test -g "can create, edit, and delete"
```

After a run, open the HTML report:

```bash
npm run report
```

## Debugging a failure

When a test fails, Playwright captures:
- A **video** of the run (`test-results/.../video.webm`)
- A **screenshot** at the moment of failure
- A **trace** with full DOM snapshots, network calls, console logs

Open the trace with:

```bash
npx playwright show-trace test-results/<failure-folder>/trace.zip
```

You get a time-travel debugger: scrub through every action, see what the page
looked like, what API calls fired, and what the browser logged at each step.

## Conventions

### Selectors

Prefer in this order:
1. `getByRole('button', { name: 'Submit' })` — accessible, semantic
2. `getByLabel('Email')` — for form inputs with labels
3. `[name="email"]` attribute selectors — stable across i18n changes
4. `getByTestId('habit-card')` — when nothing semantic exists, add a
   `data-testid` to the React component

Avoid CSS class selectors like `.btn-primary` — they break the moment styling
is refactored.

### Test data

Every test creates its own user via `makeUser()` from `support/testData.ts`.
The email is randomized so tests can run in parallel without colliding on the
unique email constraint, and no DB cleanup is needed between runs.

### Page Object Model

UI interactions live in `pages/*.ts`, never inline in tests. When a form
changes, you fix one file. Tests stay readable as user-level intent:

```ts
await loginPage.login(user);  // good
await page.fill('input[name="email"]', user.email);  // bad — too low-level for a test
```

## Roadmap

- **Phase 1:** Foundation + auth smoke test ✅
- **Phase 2:** Auth fixture + habit CRUD + tutorial coverage ✅
- **Phase 3:** Routine check-in with XP gain, multi-day streaks, schedule edits
- **Phase 4:** GitHub Actions CI workflow with docker-compose orchestration

## License

Apache 2.0 — same as the rest of the Beyou project.
