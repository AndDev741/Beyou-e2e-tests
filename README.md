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
| `tests/user-photo-access.spec.ts` | API-only: `GET /user/photo/{id}` serves the bytes to a signed URL and answers 403 to an unsigned, forged, truncated, re-pointed or re-dated one. Locks in the fix for the endpoint that used to answer anybody who could guess a user id |
| `tests/user-photo-removal.spec.ts` | `DELETE /user/photo` clears BOTH stored photos (the uploaded file and the Google avatar URL), is idempotent, and the export carries the uploaded JPEG as decodable base64. Also proves an empty `photo` edit does NOT remove an upload — the trap that made the feature look present |
| `tests/daily-briefing.spec.ts` | The new-day dialog. Above all: dismissing it writes a SERVER column, so it stays closed across a reload and on every other device — a localStorage implementation passes every unit test in the repo and fails this. Also that an account with nothing scheduled is never interrupted, that the endpoint answers in full with the LLM switched off, that acknowledging keeps the FIRST timestamp, that the panel never moves pages on its own, that the configuration screen can get the dialog back without un-acknowledging the day, that a PENDING summary is polled until it lands or gives way to the fallback line (no skeleton left up), that a goal months away still earns the dialog with its pace, and that yesterday's journal shows in the dialog while the briefing payload never carries it |
| `tests/mood.spec.ts` | A tap on the dashboard mood widget does NOT delete the day's journal entry — the cross-repo contract between a component choosing `PATCH` and a controller refusing to touch the note. Plus one row per day however often you write it, future days refused, and one account never seeing another's diary |
| `tests/form-survives-refresh.spec.ts` | Coming back to the tab refetches the page's list, and that must not wipe a half-filled create form: goal, sub-goal (the one that did), habit, task, category. The refresh is fired the way the hook hears it and the spec waits for the list's GET before reading the field |
| `tests/goal-archive.spec.ts` | Archiving a goal takes its sub-goals under one stamp and restoring brings back exactly those (one archived on its own stays put); archiving moves no XP; nothing new goes under an archived goal but an existing sub-goal stays editable; and the page round trip: archive from the card, find it under Archived, restore |
| `tests/notebook.spec.ts` | The study notebook through the UI: a topic gets a board, a node becomes a real child page that shows up in the tree, the editor's autosave reaches the server and survives a reload, and marking the only node done finishes the topic above it and pays both pages (+30 XP). A page gets an icon from its header and can go back to the default. On desktop a notebook page drops the shell's bottom spacer while other pages keep it. Deleting a page lands on its parent with no delete dialog left open. A page's starters leave the moment something is written (in prod, "Add cards" once replaced a page's notes), "Add cards" adds the deck and a card's answer opens on a click, and a code block's language is picked from a list and saved, with an unknown name falling back to text. Also the full-screen board adding a node, and the home listing topics with their progress |
| `tests/notebook-agent.spec.ts` | The assistant changes a notebook page while it is open. The turn is played back (no model in the stack): the board tools' writes go through the real REST endpoints while the stream is intercepted, and the stream reports the `notebook` domain. The board, the sidebar tree, the page title and the editor show the change without a reload, and typing afterwards keeps the assistant's notes on the server. Also coming back to a page inside the app shows the notes written on it, which used to show the document as first opened |
| `tests/notebook-sync.spec.ts` | One page written from two places. The content endpoint refuses a save from an older revision with `NOTEBOOK_CONTENT_CONFLICT`. Notes appended to a page that is open (the assistant, the study room) survive the next edit there and show up in it; two tabs editing different paragraphs both keep their text with no question; the same paragraph edited in two tabs opens the conflict dialog, and keeping both keeps both |
| `tests/notebook-trail.spec.ts` | A roadmap edited from the phone, on the wire. A node sent with no coordinates goes on the next free grid cell, after the node named, and the page gets the block that shows its board on the web; coordinates come in pairs, and a node can only follow a page node of the same board. An order makes the board one path through every node, and an order that leaves a node out is refused |
| `tests/notebook-rules.spec.ts` | API-only: another account's page answers `NOTEBOOK_PAGE_NOT_OWNED`, and a roadmap draft is stored at once (202, DRAFTING) and answers `NOTEBOOK_DRAFT_NOT_OWNED` to anyone else; done, undone, done pays 15 XP once; the last node done finishes the page holding the board; a link that would put a page on its own board is refused with `NOTEBOOK_BOARD_CYCLE`; a link source pointing at `127.0.0.1:9091` is refused with `NOTEBOOK_SOURCE_URL_REFUSED` before any row exists; and pasted text is read in the background and is visible, as inherited, from the page below |
| `tests/notebook-study.spec.ts` | A review session schedules every due card and pays at the end (+2 XP, nothing left due). A roadmap draft is stored by the real backend, shows what it is drafting while it waits, becomes a real topic whose drafted subtopics are a node's own board, and is gone once the topic exists; tidying the fresh draft moves nothing. A draft closed by a click outside the dialog waits on the home, reopens with its form and nodes, and can be deleted. The study room opens on its setup (goal, notes scope, sources), finds sources with the web search stubbed and adds them for real, keeps the setup across a reload, and opens on the chat afterwards. The study room's side panels resize by dragging, fold into a rail, and keep the layout across a reload. A study-room answer opens its citation and saves to the page. Only the model's output is stubbed; every write goes to the real backend |

The table above lists the specs whose rule would be expensive to get wrong later, not the whole
suite: `tests/` currently holds 45 spec files. Run `ls tests/` for the rest.

Everything except `auth.spec.ts`, `auth-persistence.spec.ts`, and
`auth-failures.spec.ts` uses `fixtures/auth.ts` to set up an authenticated
browser context without driving the auth UI for every test — fast, hermetic,
and lets each spec focus on the flow under test.

Two things can put a modal over the dashboard, and `fixtures/auth.ts` stubs both out so a
spec only meets the one it is about:

| Fixture | Tutorial | Daily Briefing |
|---------|----------|----------------|
| `authedPage` | bypassed | stubbed as already seen |
| `freshAuthedPage` | runs (drive it yourself) | stubbed as already seen |
| `briefingPage` | bypassed | runs (drive it yourself) |

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
