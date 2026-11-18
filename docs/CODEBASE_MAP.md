# Sentinel: Complete Codebase Map & Module Reference

> **Purpose**: A reference guide mapping every source file, module responsibility, API signature, component tree, and inter-file dependency across the Sentinel repository.

---

## 1. Directory Tree Overview

```
Sentinel/
├── docker-compose.yml          # Container orchestration (backend:3001, frontend:3000)
├── package.json                # Root NPM scripts for dev/build/demo
├── .gitignore                  # Git exclusion rules
├── backend/
│   ├── .env                    # Environment configuration (secrets & endpoints)
│   ├── alertTypes.js           # Single source of truth for the 4 fixed alert types
│   ├── atomApi.js              # Ingestion client for ATOM API (real, demo, or random mock)
│   ├── auth.js                 # OneLogin OIDC authentication & Express middleware
│   ├── db.js                   # SQLite database engine, queries, migrations & schema
│   ├── demoData.js             # Deterministic seed generator (seed: atom-demo)
│   ├── Dockerfile              # Production Node 20-alpine container with C++ build tools
│   ├── freshdeskApi.js         # Freshdesk API v2 client with mock mode fallback
│   ├── package.json            # Backend dependencies (Express, better-sqlite3, Passport)
│   ├── server.js               # Express application entry point & REST endpoints
│   └── sync.js                 # Node-cron scheduler for periodic ATOM synchronization
├── frontend/
│   ├── .env                    # React development flags (DANGEROUSLY_DISABLE_HOST_CHECK)
│   ├── Dockerfile              # Multi-stage production build (Node builder -> Nginx alpine)
│   ├── nginx.conf              # Nginx reverse proxy configuration for port 80
│   ├── package.json            # Frontend dependencies (React 18.2, react-scripts)
│   ├── public/
│   │   └── index.html          # HTML shell importing Google Fonts (IBM Plex Sans/Mono)
│   └── src/
│       ├── App.css             # Root 3-pane layout styles
│       ├── App.js              # Root container managing authentication gate & routing
│       ├── index.css           # Global design system, CSS variables & theme tokens
│       ├── index.js            # React DOM mounting
│       ├── hooks/
│       │   ├── useAuth.js         # Authenticated user state hook querying /auth/me
│       │   └── useRegionRoute.js  # Hash router (#/dashboard, #/history, #/settings)
│       ├── pages/
│       │   ├── DashboardPage.js   # Live upcoming alerts triage view
│       │   ├── HistoryPage.js     # Historical playlist & alert drill-down
│       │   ├── ContactsPage.js    # Feed & alert-type Freshdesk contact configuration
│       │   └── LoginPage.js       # OneLogin branded authentication splash screen
│       └── components/
│           ├── AlertGroups.js     # Collapsible grouped cards view by state
│           ├── FilterBar.js       # Search input, dropdowns & state filter chips
│           ├── Header.js          # Top telemetry bar, sync status, stats & user menu
│           ├── IssueDetail.js     # Slide-over panel with timeline, tickets & occurrences
│           ├── IssueTable.js      # Main alerts table with inline state action buttons
│           ├── LoadingScreen.js   # Animated NOC radar loading screen
│           ├── RegionNav.js       # Navigation sidebar for pages and APAC/US/EMEA regions
│           ├── SRETerminal.js     # Hidden floating SRE debug console ('letmein')
│           ├── TicketModal.js     # Freshdesk ticket generator modal with preview
│           └── UserBadge.js       # Current authenticated user avatar & dropdown menu
└── docs/                       # Project documentation
    ├── ARCHITECTURE.md
    ├── CODEBASE_MAP.md
    ├── OPERATIONS_AND_SECRETS.md
    └── UPGRADE_ROADMAP.md
```

---

## 2. Backend Modules

### `backend/alertTypes.js`
- **Role**: Single Source of Truth (SSOT) for alert types.
- **Exports**:
  - `ALERT_ENUM`: `{ HOLE: 'HOLE', NO_PLAYLIST: 'NO_PLAYLIST', DURATION_MISMATCH: 'DURATION_MISMATCH', MISSING_IN_CLOUD: 'MISSING_IN_CLOUD' }`
  - `ALERT_LABEL`: Human-readable labels used in UI.
  - `ALERT_SUBJECT`: Friendly strings for Freshdesk ticket subjects.
  - `ALERT_KEYS`: Ordered array of the 4 canonical keys.
  - `toEnumKey(raw)`: Fuzzy string matcher normalizing raw ATOM strings to canonical keys.
  - `label(enumKey)`: Looks up display label.
  - `subjectFriendly(enumKey)`: Subject-friendly label lookup.
  - `buildSubject(enumKey, feed_code, playlist_date)`: Produces `TOC Alert [AM3] : {friendly} - {feed} - {date}`.
  - `isValid(enumKey)`: Boolean validator.

### `backend/db.js`
- **Role**: Embedded SQLite database layer via `better-sqlite3`.
- **Database Path**: Defaults to `atom_dashboard.db` in `backend/` or configured via `DB_PATH`.
- **Key Functions**:
  - `getDb()`: Lazy initializer configuring `WAL` mode and foreign keys.
  - `initSchema()` & `initFreshdeskSchema()`: DDL execution and automated schema migrations.
  - `upsertIssue(issue)`: Composite upsert on `(atom_issue_id, playlist_id)`.
  - `insertOccurrenceIfNotExists(occ)`: Scoped occurrence insertion with playlist time resolution.
  - `findSameDayPreviousTicket(params)`: Cross-playlist same-day duplicate ticket detector.
  - `checkAndMarkPersistence(...)`: Computes and marks `has_previous_ticket_same_day` flag.
  - `getUpcomingIssues(filters)`: Queries issues where `playlist_start_time >= now()` with occurrence statistics.
  - `getHistoryFeeds()`, `getHistoryPlaylists()`, `getHistoryIssues()`: Hierarchical queries for historical analysis.
  - `resolveContacts(feed_code, issue_type, ticket_type)`: Resolves recipient emails and customer metadata based on general settings and per-alert overrides.
  - `buildFreshdeskPayload(issue, ticket_type)`: Assembles Freshdesk API JSON object including HTML summary table.
  - `storeFreshdeskTicket(...)`: Logs created ticket and links it to the active issue record.

### `backend/auth.js`
- **Role**: OneLogin OIDC authentication provider using Passport.js.
- **Exports**:
  - `passport`: Configured passport instance with `OpenIDConnectStrategy`.
  - `requireAuth(req, res, next)`: Middleware blocking unauthorized web requests.
  - `requireAuthApi(req, res, next)`: Middleware returning 401 JSON for unauthorized API requests.
  - `IS_CONFIGURED`: Boolean flag indicating if OIDC environment variables are populated.
  - `ALLOWED_DOMAIN`: Domain restriction (`@amagi.com`).
- **Dev Bypass**: If `OIDC_ISSUER` or `OIDC_CLIENT_ID` are not set, automatically injects a mock user (`dev@amagi.com`) allowing full local testing.

### `backend/atomApi.js`
- **Role**: ATOM v1 API client (spec: `<ATOM_BASE_URL>/docs.yaml`, e.g. `https://am-staging.amagi.tv/v1/api/docs`).
- **Operating Modes**:
  1. *Demo Mode* (`DEMO_MODE=true`): No polling; data is seeded in SQLite. Playlist context returns a synthetic playlist.
  2. *Live Mode* (`ATOM_BASE_URL` set): Auth via `X-API-Key` (`ATOM_API_KEY`), a static Bearer JWT (`ATOM_BEARER_TOKEN`), or email/password login (`ATOM_EMAIL` + `ATOM_PASSWORD`, auto-renewed).
  3. *Mock Fallback Mode*: Synthesizes randomized alerts (TOC and other types, severities, snoozes).
- **Reads**: `GET /alerts` (paginated, all types by default, `states=active,snoozed`, `entity[product]=CP`), `GET /alerts/{id}`, `GET /cache/published_playlist`, `GET /customers/{automation_url}/feeds/{feed_code}/playlist`, `GET /customers/{automation_url}?detailed=true`.
- **Writes** (only with `ATOM_WRITEBACK=true` against a live ATOM): `PATCH /alerts` to snooze/de-snooze and comment. Never resolves; never patches `labels`/`custom_details`.
- **Mapping**: every alert field is kept (severity, name, description, raw type, lifecycle state, snooze/resolve info, duration, headend, automation, dedup/correlation IDs, labels). The 4 TOC types map to enum keys; other types keep their raw ATOM type.

### `backend/atomCatalog.js`
- Syncs ATOM customers → `atom_feeds` (feed name, customer, timezone, broadcast start, headends + health) for automations seen on alerts, every `ATOM_CATALOG_REFRESH_HOURS`. Pre-fills an empty `feed_ticket_config.customer_name`.

### `backend/atomTime.js`
- Timezone helpers: broadcast date in the feed's timezone, end of broadcast day (snooze option), local time labels, timezone → region.

### `backend/freshdeskApi.js`
- **Role**: Integration client for Freshdesk REST API v2.
- **Exports**:
  - `createTicket(payload)`: Posts ticket to `https://{FRESHDESK_DOMAIN}/api/v2/tickets`. If domain/key are missing, returns deterministic mock ticket (`INC-10001`, `INC-10002`...).
  - `getTicket(freshdesk_id)`: Fetches status of an existing ticket.
  - `isMock()`: Returns boolean indicating whether client is operating in mock mode.

### `backend/sync.js`
- **Role**: Background polling engine.
- **Mechanism**: Scheduled via `node-cron` to execute every 5 minutes (`*/5 * * * *`).
- **Exports**:
  - `startSyncScheduler()`: Boots the background scheduler.
  - `getSyncStatus()`: Returns `{ isSyncing, lastSyncTime, lastSyncStatus, lastSyncError }`.
  - `triggerSync()`: Programmatic trigger for on-demand synchronization.

### `backend/demoData.js`
- **Role**: Seeds realistic, deterministic broadcast data for development and demos.
- **Seed Constants**:
  - Feeds: `BALP_APAC_HD`, `OCA_APAC_HD`, `FAILARMY_US`, `WSSPY_EMEA_HD`, `INSIGHTV_EMEA`.
  - Sequential Playlist IDs starting at `22262007`.
  - Seed dates: `2026-04-13`, `2026-04-14`, `2026-04-15`.
  - Pre-seeded contacts and overrides for Blue Ant Media.

### `backend/server.js`
- **Role**: Main HTTP server.
- **Mount Points**:
  - CORS with credentials support.
  - Session management with `connect-sqlite3` backing `sessions.db`.
  - Authentication routes: `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/error`, `/auth/me`.
  - API Routes (Protected by `requireAuthApi`):
    - `GET /api/stats`, `GET /api/regions`, `GET /api/alert-types`
    - `GET /api/issues/upcoming`, `GET /api/issues`
    - `GET /api/issues/:atomIssueId/playlist/:playlistId`
    - `PATCH /api/issues/:atomIssueId/playlist/:playlistId/state`
    - `POST /api/tickets`, `GET /api/tickets/check`
    - `GET /api/history/feeds`, `GET /api/history/playlists`, `GET /api/history/issues`
    - `GET /api/playlist-timeline`
    - `GET /api/settings/contacts`, `PUT /api/settings/contacts/:feed_code`
    - `POST /api/freshdesk/preview`, `POST /api/freshdesk/create`
    - `POST /api/sync`, `GET /api/sync/status`

---

## 3. Frontend Architecture & Components

### Component Tree
```
App
├── LoadingScreen (conditional during boot)
├── LoginPage (conditional if unauthenticated)
└── App Layout
    ├── Header
    │   ├── Header Stats (Penalty / Ack / Ticketed)
    │   ├── UserBadge (User dropdown & sign-out)
    │   └── Sync Button
    ├── RegionNav (Side Navigation)
    │   ├── Page Navigation (Upcoming / History / Settings)
    │   └── Regional Filter (All / APAC / US / EMEA)
    ├── App Right Content Area
    │   ├── DashboardPage (when page == 'dashboard')
    │   │   ├── FilterBar (Search, Type, Dates, State chips)
    │   │   ├── IssueTable (Rows with state actions & flags)
    │   │   └── IssueDetail (Slide-over side panel)
    │   │       ├── Tab: Occurrences
    │   │       ├── Tab: Playlist Timeline
    │   │       └── Ticket Tracking & TicketModal
    │   ├── HistoryPage (when page == 'history')
    │   │   ├── Feeds Column
    │   │   ├── Playlists Column
    │   │   └── Playlist Alerts Column + IssueDetail
    │   └── ContactsPage (when page == 'settings')
    │       ├── Feed Selector
    │       ├── General Contacts Card
    │       └── Per-Alert Overrides Table
    └── SRETerminal (Floating hidden debug console)
```

### Modules Breakdown:

#### `frontend/src/App.js`
- Coordinates high-level application state: `page`, `region`, `authenticated`, `stats`, `regions`.
- Enforces auth gating using `useAuth()`.
- Fetches metadata and statistics upon region change.

#### `frontend/src/hooks/useRegionRoute.js`
- Custom hash router without heavy routing dependencies.
- Handles parsing and updating of URLs:
  - `#/` -> Dashboard (All regions)
  - `#/dashboard/apac` -> Dashboard (APAC)
  - `#/history/us` -> History (US)
  - `#/settings/contacts` -> Settings

#### `frontend/src/hooks/useAuth.js`
- Performs `GET /auth/me` with cookie credentials.
- Exposes `{ user, loading, authenticated, auth_configured, logout }`.

#### `frontend/src/pages/DashboardPage.js`
- Primary real-time operations dashboard.
- Maintains 30-second polling interval for incoming alerts.
- Connects state transitions to `SREBus` for telemetry.

#### `frontend/src/components/IssueTable.js`
- Displays alert list with columns: State, Feed, Issue Type, Playlist / Start, Asset, First Occ, Last Occ, Count, Ticket, Flags.
- Embedded `StateActions` component handles inline state transitions (`penalty` -> `ack`, `ack` -> `penalty`).

#### `frontend/src/components/IssueDetail.js`
- Drawer component sliding in from right upon alert selection.
- Features:
  - Warning banner for same-day prior tickets.
  - Playout occurrence timeline showing timestamp and asset details.
  - Playlist timeline showing chronological versions and alerts matched to each version.
  - Button to open `TicketModal`.

#### `frontend/src/components/TicketModal.js`
- Modal dialog for Freshdesk ticket generation.
- Allows choosing between **Customer Ticket** and **Internal Ticket**.
- Dynamically queries `/api/freshdesk/preview` to display resolved email recipients, subject, and customer metadata before submission.

#### `frontend/src/components/SRETerminal.js`
- Hidden engineering console attached to `window`.
- Listens to global keystrokes for `letmein` or `Ctrl + \``.
- Exposes internal state, network traffic, Freshdesk payloads, and diagnostics.
