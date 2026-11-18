# Sentinel: Complete Codebase Map & Module Reference

> **Purpose**: Every source file, its responsibility, exports, routes and component tree.
> **Last updated**: 2026-11-18 · ATOM specifics: [`ATOM_INTEGRATION.md`](ATOM_INTEGRATION.md) · Running it: [`OPERATIONS_AND_SECRETS.md`](OPERATIONS_AND_SECRETS.md)

---

## 1. Directory Tree

```
Sentinel/
├── docker-compose.yml            # backend :3001 (env_file backend/.env, volume backend/data, healthcheck) + frontend :3000
├── package.json                  # Root scripts: install:all, dev:backend, dev:frontend, demo, docker:up/down
├── .nvmrc                        # Node 18 (local dev; native modules are built for it)
├── .gitignore                    # Ignores .env, *.db, .atom_session.json, backend/data/, node_modules, …
├── README.md
├── backend/
│   ├── .env                      # LOCAL ONLY (git-ignored, chmod 600): ATOM credential, Freshdesk key, SESSION_SECRET
│   ├── .env.example              # Template documenting every setting
│   ├── .dockerignore             # Keeps .env, DBs, session file, node_modules, tests out of the image
│   ├── Dockerfile                # node:20-alpine + build tools for better-sqlite3
│   ├── alertTypes.js             # 4 TOC types, fuzzy ATOM-type mapping, labels/subjects, humanize()
│   ├── atomApi.js                # ATOM v1 client: auth (key/refresh/bearer/login), /alerts, catalog, playlists, PATCH
│   ├── atomCatalog.js            # /customers?detailed=true → atom_feeds (+ monitoring flags, customer-name prefill)
│   ├── atomGuard.js              # Protects ATOM: ≤ N req/min, ≤ M in flight, circuit breaker (pauses on timeouts/5xx/429)
│   ├── atomMock.js               # Realistic offline ATOM (mock mode): prod-shaped alerts in the same saved views
│   ├── atomTime.js               # Timezone helpers: broadcast date, end of broadcast day, local labels, tz → region
│   ├── auth.js                   # OneLogin OIDC (Passport) + dev bypass
│   ├── db.js                     # SQLite (better-sqlite3): schema, queries, filters, stats, tickets, ATOM catalog
│   ├── demoData.js               # Deterministic demo seed (feeds, playlists, contacts, ATOM enrichment)
│   ├── freshdeskApi.js           # Freshdesk v2 client with mock fallback
│   ├── migrator.js               # Applies migrations/*.sql in order (tracked in _schema_migrations)
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_contacts_and_freshdesk.sql
│   │   ├── 003_state_and_persistence.sql
│   │   ├── 004_atom_full_mapping.sql   # full ATOM alert columns on issues + atom_feeds
│   │   ├── 005_atom_alert_links.sql    # feed_name, amg_id, source_url
│   │   ├── 006_feed_monitoring.sql     # atom_feeds.data_only / monitored
│   │   ├── 007_atom_views.sql          # view membership on issues + atom_views
│   │   └── 008_app_meta.sql            # app_meta key/value (last sync time)
│   ├── server.js                 # .env loader, Express app, sessions, all routes, health, metrics
│   ├── sync.js                   # 5-min scheduler: fetch → catalog → monitoring filter → upsert → resolution check
│   ├── ticketText.js             # All Freshdesk ticket + follow-up wording (per alert type, priority, templates)
│   └── tests/                    # node:test — run with Node 18: npm --prefix backend test
│       ├── helpers/fakeAtom.js   # Fake ATOM server mirroring prod behaviour
│       ├── alertTypes.test.js · db.test.js · api.test.js
│       ├── atomApi.test.js · atomRefresh.test.js · atomSync.test.js · atomWriteback.test.js (+ follow-ups)
│       ├── ticketText.test.js · atomViews.test.js · atomGuard.test.js · atomMock.test.js
├── frontend/
│   ├── .env                      # Dev-server flags only (HOST, DANGEROUSLY_DISABLE_HOST_CHECK)
│   ├── .dockerignore
│   ├── Dockerfile                # node:20-alpine build → nginx:alpine
│   ├── nginx.conf                # Serves the SPA; proxies /api/ and /auth/ to backend:3001
│   ├── public/index.html         # IBM Plex Sans/Mono
│   └── src/
│       ├── index.css             # "Ember" warm theme tokens, buttons, empty states
│       ├── App.js / App.css      # Auth gate, shell layout, stats polling
│       ├── lib/
│       │   ├── alerts.js         # Labels, TOC list, severity/triage metadata, time/duration formatters
│       │   └── api.js            # fetch wrapper (+ SRE traffic log), setTriageState()
│       ├── hooks/
│       │   ├── useAppConfig.js   # Shared /api/demo-status flags (demo, live, write-back)
│       │   ├── useAuth.js        # /auth/me
│       │   └── useRegionRoute.js # Hash router
│       ├── pages/
│       │   ├── DashboardPage.js  # KPI strip, filters, TOC / Other sections, table|board, drawer
│       │   ├── HistoryPage.js    # Feeds → playlists → alerts
│       │   ├── ContactsPage.js   # Feed contacts + per-type overrides + "In ATOM" feed card
│       │   └── LoginPage.js
│       └── components/
│           ├── Header.js         # Top bar: brand, page crumb, region, sync status, Sync, user
│           ├── RegionNav.js      # Sidebar: pages, regions (needs-action counts), ATOM status
│           ├── KpiStrip.js       # Needs action / Ack / Ticketed / severity bar / ATOM states (click = filter)
│           ├── FilterBar.js      # Search, type (TOC + other), scope, triage, severity, ATOM state, dates, sort
│           ├── IssueTable.js     # Rows: triage+Ack, severity, feed, alert, ATOM state, start, playlist, ticket
│           ├── AlertGroups.js    # Board: Penalty / Ack / Ticketed columns of cards
│           ├── IssueDetail.js    # Drawer: Overview · Playlist · Activity · Tickets + sticky actions
│           ├── AckButton.js      # Ack/Reopen with ATOM snooze picker (when write-back is on)
│           ├── Pills.js          # SeverityPill, AtomStatePill, TriagePill, TypeLabel
│           ├── TicketModal.js    # New ticket (full email preview, covers N) | Follow up (templates, note, preview)
│           ├── SRETerminal.js    # Hidden debug console ('letmein' / Ctrl+`)
│           └── LoadingScreen.js · UserBadge.js
└── docs/
    ├── ARCHITECTURE.md · CODEBASE_MAP.md · OPERATIONS_AND_SECRETS.md · UPGRADE_ROADMAP.md
    ├── ATOM_INTEGRATION.md        # Full ATOM reference
    ├── TICKETS_AND_FOLLOWUPS.md   # Ticket wording, follow-ups, bot plan
    └── ATOM_API_ACCESS_REQUEST.md # Shareable API-key request for the ATOM team
```

---

## 2. Backend Modules

### `backend/alertTypes.js`
- `ALERT_ENUM`, `ALERT_KEYS`: the 4 TOC keys `HOLE`, `NO_PLAYLIST`, `DURATION_MISMATCH`, `MISSING_IN_CLOUD`.
- `ALERT_LABEL`, `ALERT_SUBJECT`: UI labels and Freshdesk subject words.
- `toEnumKey(raw)`: ATOM type → TOC key, or `null` for other types (e.g. `no_published_playlist` → `NO_PLAYLIST`, `playlist_hole` → `HOLE`).
- `humanize(raw)`: `player_rescue_detected_alert` → "Player Rescue Detected".
- `label(key)`, `subjectFriendly(key)`: fall back to `humanize` for non-TOC types.
- `buildSubject(key, feed, date)`: `TOC Alert [AM3] : {friendly} - {feed} - {date}`.
- `isValid(key)`.

### `backend/atomApi.js`
- **Auth**:
  - Mode priority: `ATOM_API_KEY` → `ATOM_REFRESH_TOKEN` → `ATOM_BEARER_TOKEN` → email/password.
  - Single-flight refresh; rotated tokens persisted to `ATOM_SESSION_FILE`; 401 → one renewal and retry.
  - `authInfo()` reports mode, expiry and error, never secrets.
- **Reads**:
  - `fetchAlerts({feedLookup})` → `{issues, truncated}`, querying state × type with the 72h lookback.
  - `queryPlan()`, `applyFeedInfo()`, `getIssues()`, `getAlert(id, {history})`, `getIssueDetails()` (no HTTP).
  - `getPlaylistTimeline()`, `getPlaylist()`, `getCustomer()`.
  - After a 403, playlist endpoints are skipped for 6h.
- **Writes**: `patchAlerts()`, `snoozeAlert()`, `desnoozeAlert()`, `commentAlert()`.
  - Active only with `ATOM_WRITEBACK=true` on a live ATOM.
  - Refuses `resolve` and `labels` / `custom_details`.
- **Mapping**: `normalizeAlert()` (field table: ATOM_INTEGRATION §4.4), `DEFAULT_ALERT_TYPES`.
- **Flags**: `isLive()`, `isWritebackEnabled()`.
- **Mock / demo**: random alerts, synthetic playlists.

### `backend/atomGuard.js`
`createGuard({perMin, concurrency, threshold, baseCooldownMs, maxCooldownMs})` → `{run(fn), info(), isPaused()}`. Every ATOM call in `atomApi.js` goes through it (defaults: 20/min, 1 in flight, 3 failures → pause 2 → 30 min). See ATOM_INTEGRATION §2a.

### `backend/atomMock.js`
`generate(now)` → prod-shaped raw alerts + view membership (deterministic per UTC day, alerts resolve over time); `customer(url)` → detailed customer record; `VIEWS`. Used by `atomApi` when `ATOM_BASE_URL` is empty.

### `backend/atomCatalog.js`
- `syncCatalog(urls?)`: fetches stale automations (6h refresh, up to 300 per sync, 6 in parallel) and upserts `atom_feeds`. Returns `{fetched, feeds, prefilled, errors}`.
- `feedsFromCustomer()`: computes `data_only` and `monitored` (a headend has `health.monitoring = true` and the customer is not `data_only`; a feed with no headends counts as monitored).

### `backend/atomTime.js`
`broadcastDate(iso, tz, start)`, `endOfBroadcastDay(now, tz, start)`, `formatLocal(iso, tz)`, `regionFromTimeZone(tz)`, `parseClock()`, `validTz()`.

### `backend/db.js`
- **Setup**: `getDb()` runs WAL mode, migrations, `initSchema()` and `initFreshdeskSchema()`. The last one also repairs `freshdesk_tickets` columns.
- **Issues**:
  - `upsertIssue(issue)`: ATOM columns are overwritten only by an ATOM sync (`atom_sync`); triage `state` is preserved.
  - `updateAtomLifecycle(id, fields)`, `getOpenAtomIssues()`.
  - `insertOccurrenceIfNotExists()`, `updateOccurrenceCount()`, `updateIssue()`.
- **Queries**:
  - `getUpcomingIssues(filters)`, `getIssues(filters)`, `applyFilters()`.
  - Filters: region, feed, type, playlist, dates, triage `state`, `severity`, `atom_state`, `toc_only`, `sort=severity`.
  - `getIssueByCompositeKey()`, `getIssueById()`, history queries, playlist timeline.
- **Meta / stats**:
  - `getStats(region)`: triage counts plus `atom_active`, `atom_snoozed`, `atom_resolved`, `toc_open`, `other_open`, `by_severity`, `writeback_errors`.
  - `getDistinctRegions()`, `getOtherIssueTypes()`.
- **Same-day persistence**: `findSameDayPreviousTicket()`, `checkAndMarkPersistence()`, `createTicket()`.
- **ATOM catalog**: `getAtomFeed()`, `upsertAtomFeed()`, `getStaleAutomationUrls()`, `automationSyncedWithin()`, `countAtomFeeds()`, `prefillCustomerName()`, `isAlertMonitored()`, `purgeUnmonitoredAlerts()`.
- **Freshdesk**: `resolveContacts()`, `buildSubject()`, `buildFreshdeskPayload()` (via `ticketText`), `getRelatedOpenAlerts()`, `getParentTicket()`, `countFollowups()`, `storeFreshdeskTicket()` (original tickets set `state='ticketed'`), `getFreshdeskTicketsForIssue()`, feed config and override CRUD.

### `backend/ticketText.js`
- `buildTicket({issue, related, feed, contacts, ticketType})` → `{subject, html, priority, priorityReason, items}`.
- `buildFollowup({issue, related, feed, contacts, ticket, template, note, number})` → `{html}`.
- `suggestFollowup(issue, related)`, `FOLLOWUP_TEMPLATES`. Details: [`TICKETS_AND_FOLLOWUPS.md`](TICKETS_AND_FOLLOWUPS.md).

### `backend/sync.js`
- **Steps**: `fetchAlerts` → `syncCatalog` → `applyFeedInfo` → monitoring filter and purge → upsert, occurrences and same-day check per alert → playlist versions (≤ 150 per sync, each feed+date ≤ every 30 min) → `detectResolved()` (≤ 200 checks, 8 parallel, skipped when truncated).
- **Exports**: `startSyncScheduler()` (every 5 min), `triggerSync()`, `getSyncStatus()` → `{isSyncing, lastSyncTime, lastSyncStatus, lastSyncError, counts, atom_live, atom_writeback, atom_auth}`.

### `backend/server.js`
- **Startup**: loads `backend/.env` before anything reads `process.env`. Env wins; skipped in tests.
- **Sessions**: `connect-sqlite3` in `SESSION_DB_DIR` (default `backend/`). Passport OIDC or dev bypass.
- **Routes** (all `/api/*` behind `requireAuthApi`):

| Area | Routes |
|---|---|
| Auth | `GET /auth/login`, `/auth/callback`, `/auth/logout`, `/auth/error`, `/auth/me` |
| Meta | `GET /api/demo-status` (demo, freshdesk_mock, atom_live, atom_writeback), `/api/health`, `/api/regions`, `/api/issue-types`, `/api/issue-types/other`, `/api/alert-types`, `/api/stats` |
| Issues | `GET /api/issues/upcoming`, `GET /api/issues`, `GET /api/issues/:atomIssueId/playlist/:playlistId`, `PATCH …/state` (`{state, snooze_until?}` → `+atom`), `GET …/snooze-options`, `GET …/context`, legacy `GET/POST /api/issues/:id` |
| ATOM | `GET /api/atom/feeds/:feed_code`, `GET /api/atom/alerts/:alertId` |
| Tickets | `GET /api/tickets/check`, `POST /api/tickets`, `POST /api/freshdesk/preview` (full HTML, priority + reason, covers), `POST /api/freshdesk/create` (covers related alerts → Ticketed, ATOM comments), `POST /api/freshdesk/followup/preview`, `POST /api/freshdesk/followup`, `GET /api/freshdesk/tickets/:atomIssueId/:playlistId` |
| History | `GET /api/history/feeds`, `/api/history/playlists`, `/api/history/issues`, `/api/playlist-timeline` |
| Settings | `GET /api/settings/contacts`, `GET`/`PUT /api/settings/contacts/:feed_code`, `GET /api/settings/feeds`, `/api/settings/issue-types` |
| Sync & ops | `POST /api/sync`, `GET /api/sync/status`, `GET /healthz/live`, `/healthz/ready`, `/metrics` (incl. ATOM state and write-back error gauges) |

### Other backend files
- **`freshdeskApi.js`**: `createTicket()`, `getTicket()`, `isMock()` (mock tickets `INC-10001…` when domain/key are unset).
- **`auth.js`**: Passport OIDC, `requireAuthApi`, `IS_CONFIGURED`, dev bypass user `dev@amagi.com`.
- **`demoData.js`**: 5 feeds, April 2026 dates, sequential playlist IDs from `22262007`, contacts and overrides. ATOM enrichment adds a feed catalog with timezones and headends, severities and descriptions per type, and 3 non-TOC alerts (active, snoozed, resolved). The dates are historical, so the live dashboard is empty in demo mode; use History.
- **`migrator.js`**: applies `migrations/*.sql` once each, in name order.

---

## 3. Frontend

### Component tree
```
App
├── LoadingScreen / LoginPage (boot, unauthenticated)
└── Shell
    ├── Header (brand · page crumb · region · demo tag · sync status · Sync · UserBadge)
    ├── RegionNav (Workspace pages · Regions + needs-action counts · ATOM Live/Mock/Demo + write-back · warnings)
    └── Page
        ├── DashboardPage
        │   ├── KpiStrip (click a card = filter)
        │   ├── FilterBar
        │   ├── Section "TOC alerts" ───────┐  each: IssueTable | AlertGroups (board),
        │   ├── Section "Other ATOM alerts" ┘  200 rows per page + Show more / Show all
        │   └── Drawer: IssueDetail
        │        ├── Overview (alert, when + feed-local time, where + headend health, ATOM record, CloudPort link)
        │        ├── Playlist (items around the alert time · published versions)
        │        ├── Activity (ATOM transitions · occurrences)
        │        ├── Tickets
        │        └── Actions: AckButton (+ snooze picker) · Create Freshdesk ticket → TicketModal
        ├── HistoryPage (feeds → playlists → alerts, severity/ATOM pills, IssueDetail)
        └── ContactsPage (feed select · "In ATOM" card · general contacts · per-type overrides)
    └── SRETerminal
```

### Notes per module
- **`lib/alerts.js`**: the UI's single source for labels (mirrors `alertTypes.js`), severity order, triage metadata, `fmtShort`, `fmtLong`, `fmtInZone`, `fmtDuration`, `relTime`.
- **`lib/api.js`**: `api(path, {method, body})` throws readable errors and logs to the SRE terminal. `setTriageState(issue, state, snooze_until)`.
- **`hooks/useAppConfig.js`**: one shared fetch of `/api/demo-status`. AckButton uses it to decide whether to show the snooze picker.
- **`DashboardPage.js`**:
  - Default filters: ATOM state "Open", sort "Priority" (triage, then severity, then start time).
  - Polls every 30s; the view mode (table or board) is remembered in `localStorage`.
- **`IssueTable.js` / `AlertGroups.js`**: both render the same issue rows; row click toggles the drawer, Enter key supported.
- **`AckButton.js`**:
  - Without write-back, Ack is immediate.
  - With write-back, a fixed-position menu offers 1h / 4h / end of broadcast day / Ack only. It closes on Esc, outside click or scroll.
  - Reopen de-snoozes. A red "!" marks a failed ATOM update.
- **`IssueDetail.js`**: Esc closes. Banners cover the same-day ticket, a failed ATOM update, and success notices such as "Snoozed in ATOM until …" and "comment added in ATOM".
- **Theme**: tokens in `index.css`. Surfaces are `--bg-*`; the copper accent is `--accent`; triage colours are `--state-*`; severity is `--sev-*`; ATOM lifecycle is `--atom-*`. Change colours there, not in components.
