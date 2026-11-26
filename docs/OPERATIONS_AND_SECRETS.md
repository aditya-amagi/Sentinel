# Sentinel: Operations, Configuration & Security Runbook

> **Target Audience**: DevOps, SREs, NOC Leads, Infrastructure Engineers  
> **Last Updated**: 2026-11-03  

---

## 1. Environment Configuration Reference

Configuration lives in `backend/.env`. The backend loads it at startup, and real environment variables win. Docker passes the same file via `env_file`. The file is git-ignored and never copied into images; keep it `chmod 600`. Start from `backend/.env.example`. ATOM settings are explained in depth in [`ATOM_INTEGRATION.md` §2](ATOM_INTEGRATION.md#2-configuration).

| Variable | Description | Required | Default / Example |
| :--- | :--- | :--- | :--- |
| `PORT` | HTTP server listening port | No | `3001` |
| `DB_PATH` | Path to primary SQLite database | No | `/app/data/atom_dashboard.db` (Docker) or `backend/atom_dashboard.db` |
| `FRONTEND_URL` | Base URL of frontend for CORS & post-auth redirects | No | `http://localhost:3000` |
| `DEMO_MODE` | Seeds fixed deterministic dataset on startup and halts ATOM polling | No | `false` (Set `true` for demo/testing) |
| `ATOM_BASE_URL` | ATOM API base incl. `/v1/api` — prod `https://am.amagi.tv/v1/api`, staging `https://am-staging.amagi.tv/v1/api` (Amagi users sign in via SSO; get a Bearer token from the web app or request an API key) | No | If empty, runs random mock generator |
| `ATOM_API_KEY` | ATOM API key, sent as `X-API-Key` | One auth option | — |
| `ATOM_ALLOW_TOKEN_RENEWAL` | Allow automatic token renewal (refresh token / login); off = API key or pasted access token only | No | `false` |
| `ATOM_REFRESH_TOKEN` | SSO **refresh** token; Sentinel renews access tokens and saves each rotated token to `ATOM_SESSION_FILE` | One auth option | — |
| `ATOM_BEARER_TOKEN` | SSO **access** token (`eyJ…`, ~24h), sent as `Authorization: Bearer` | One auth option | — |
| `ATOM_SESSION_FILE` | Rotated refresh-token store (secret, git-ignored) | No | `backend/.atom_session.json` · Docker `/app/data/.atom_session.json` |
| `ATOM_EMAIL` / `ATOM_PASSWORD` | ATOM user login; token fetched from `/auth/user/login` and renewed | One auth option | — |
| `ATOM_VIEWS` | Ingest by ATOM saved views: `auto` (region/customer views + Service Alerts), view ids, or `off` (type mode) | No | `auto` |
| `ATOM_ALERT_TYPES` | ATOM types to pull. Empty = built-in list (4 TOC types + fault types; excludes `asset_download_waiting`/`asset_submitted`/`asset_queued`). `*` = all | No | empty |
| `ATOM_ALERT_STATES` | ATOM states to pull (queried one at a time — prod has no `states` filter) | No | `active,snoozed` |
| `ATOM_LOOKBACK_HOURS` | Only alerts with `issue_start_time` ≥ now − N hours (upcoming always included). `0` = no window | No | `72` |
| `ATOM_RESOLVE_CHECKS_PER_SYNC` | `GET /alerts/{id}` checks per sync for alerts that dropped out (resolution detection) | No | `200` |
| `ATOM_PLAYLIST_LOOKUPS_PER_SYNC` | Published-playlist lookups per sync (each feed+date at most every 30 min) | No | `150` |
| `ATOM_PRODUCT` | `entity[product]` filter; empty = all products | No | `CP` |
| `ATOM_PAGE_SIZE` / `ATOM_MAX_PAGES` | Paging for `GET /alerts` (resolution detection is skipped when the page cap is hit) | No | `500` / `20` |
| `ATOM_CATALOG_REFRESH_HOURS` | Feed catalog refresh interval | No | `6` |
| `ATOM_CATALOG_MAX_PER_SYNC` | Automations whose catalog is fetched per sync (6 in parallel) | No | `300` |
| `SESSION_DB_DIR` | Directory of the login session store `sessions.db` | No | `backend/` · Docker `/app/data` |
| `ATOM_WRITEBACK` | Mirror Ack → ATOM snooze, Reopen → de-snooze, ticket → ATOM comment. Never resolves. | No | `false` |
| `FRESHDESK_DOMAIN`| Domain of Freshdesk helpdesk | No | e.g. `amagisupport.freshdesk.com` |
| `FRESHDESK_API_KEY`| API key for Freshdesk | No | If empty, runs deterministic mock (`INC-10001`...) |
| `FRESHDESK_GROUP_ID`| Target Helpdesk Group ID | No | e.g. `69000398414` |
| `FRESHDESK_TYPE` | Ticket type category in Freshdesk | No | `Issue` |
| `INTERNAL_TICKET_EMAIL`| Recipient for Internal tickets | No | `amagisupportcontact@amagi.com` |
| `OIDC_ISSUER` | OneLogin OIDC Issuer URL | No | If empty, runs in **DEV BYPASS** mode |
| `OIDC_AUTH_URL` | OneLogin Authorization URL | Conditional | e.g. `https://amagi.onelogin.com/oidc/2/auth` |
| `OIDC_TOKEN_URL` | OneLogin Token URL | Conditional | e.g. `https://amagi.onelogin.com/oidc/2/token` |
| `OIDC_USERINFO_URL`| OneLogin UserInfo URL | Conditional | e.g. `https://amagi.onelogin.com/oidc/2/me` |
| `OIDC_CLIENT_ID` | OneLogin Registered Client ID | Conditional | From OneLogin App Admin |
| `OIDC_CLIENT_SECRET`| OneLogin Registered Client Secret | Conditional | From OneLogin App Admin |
| `OIDC_CALLBACK_URL`| Authorized redirect URI | Conditional | `http://localhost:3001/auth/callback` |
| `SESSION_SECRET` | Secret key for signing session cookies | Production | Random 48-byte hex string |
| `ALLOWED_EMAIL_DOMAIN`| Restricted login domain | No | `@amagi.com` |

---

## 2. Security Notices & Status

| # | Issue | Status (2026-11-18) |
|---|---|---|
| 01 | Freshdesk API key committed in `backend/.env` | **Resolved.** The key was rotated and verified (HTTP 200). `backend/.env` and `sessions.db` were untracked, and the repository history was replaced with a fresh history containing no secrets. The old OneLogin "secret" in history was only the `.env.example` placeholder |
| 02 | `node_modules` committed | **Resolved.** Untracked and ignored |
| 03 | nginx did not proxy `/auth/` | **Resolved.** `frontend/nginx.conf` proxies `/api/` and `/auth/` |
| 04 | Docker images could contain `.env`, databases or host `node_modules` | **Resolved.** `backend/.dockerignore` and `frontend/.dockerignore` exclude them; `env_file` supplies settings at runtime |
| 05 | ATOM access depends on one person's SSO session (24h tokens, rotation, 403 on playlists) | **Open.** Service API key requested: [`ATOM_API_ACCESS_REQUEST.md`](ATOM_API_ACCESS_REQUEST.md) |
| 06 | Empty `SESSION_SECRET` fell back to a hard-coded default | **Resolved locally.** A random 96-character secret is set in `backend/.env`. Every deployment must set its own |

Rules that keep it that way:
- **Never commit** `backend/.env`, `backend/.env.old`, `backend/.atom_session.json`, `backend/data/`, `*.db`. All of these are in `.gitignore`.
- Never paste tokens or passwords into chats, tickets or screenshots. If one leaks, rotate it.
- A deleted file stays in git history. If a secret was ever committed, **rotate it**; untracking alone is not enough.

---

## 3. How to Run Sentinel

### Quick Start via NPM (Local Development)

Use **Node 18** (`.nvmrc`; native modules are built for it): `source ~/.nvm/nvm.sh && nvm use 18`. Copy `backend/.env.example` → `backend/.env` and paste the ATOM credential (one of `ATOM_API_KEY`, `ATOM_REFRESH_TOKEN`, `ATOM_BEARER_TOKEN`).

```bash
# 1. Install dependencies for root, backend, and frontend
npm run install:all

# 2. Run backend (Port 3001) in Dev Bypass mode
npm run dev:backend

# 3. In a separate terminal, run frontend (Port 3000)
npm run dev:frontend
```
Open **`http://localhost:3000`** in a browser.

### Deterministic Demo Mode
To test Sentinel with realistic linear broadcast data (republished playlists, multi-region feeds, preconfigured overrides) without any external ATOM credentials:

```bash
DEMO_MODE=true npm --prefix backend start
```
Or use the npm script:
```bash
npm run demo
```

### Production Docker Deployment

```bash
cp backend/.env.example backend/.env    # fill in the ATOM credential, Freshdesk key, SESSION_SECRET
docker compose up --build -d            # backend :3001, frontend (nginx) :3000
docker compose ps                       # backend shows (healthy) once /healthz/ready passes
docker compose logs -f backend          # look for: [sync] Done — issues:… skippedUnmonitored:…
```
- Settings come from `backend/.env` via `env_file`. Container overrides: `DB_PATH`, `SESSION_DB_DIR` and `ATOM_SESSION_FILE`, all under `/app/data`.
- `backend/data/` (mounted at `/app/data`) holds `atom_dashboard.db`, `sessions.db` and `.atom_session.json`. Back it up, and never commit it.
- The frontend waits for the backend health check. nginx proxies `/api/` and `/auth/` to `backend:3001`.
- **Laptops with Cloudflare WARP:** containers get no DNS or internet and published ports don't answer, because WARP captures Docker's 172.x networks. Exclude `172.16.0.0/12` in WARP's split tunnel, or pause WARP.

---

## 4. Operational Runbooks & Triage Scenarios

### Scenario A: Operator Reports Missing Alert on Dashboard
1. Open the hidden SRE terminal by typing **`letmein`** or pressing **`Ctrl + \``**.
2. Run `status` to inspect the total loaded issues and last sync status.
3. Run `poll` to verify when the background sync last ran and when the next poll will occur.
4. If an alert was acknowledged or marked as ticketed, it may be hidden by filters. Run `states` to list all alerts categorized by `[PENALTY]`, `[ACK]`, and `[TICKETED]`.
5. Check if filters are active in SRE terminal by running `filters`.

### Scenario B: Freshdesk Ticket Creation Fails
1. Trigger SRE terminal (`letmein`).
2. Run `fd errors` to view the exact error payload returned by Freshdesk.
3. Run `fd payload` to inspect the JSON payload constructed by `db.buildFreshdeskPayload()`.
4. Verify if the feed has a contact configured:
   - Navigate to `#/settings/contacts`.
   - Select the feed code.
   - Confirm if `Contact Email` is populated or if per-alert overrides are correctly enabled.

### Scenario C: Diagnosing Same-Day Ticket Warnings
1. When an issue displays an amber **`⚠`** badge:
   - Click the issue row to open `IssueDetail`.
   - The warning banner shows: `Ticket already created for a previous playlist version today`.
   - Click `View ↗` to view the existing ticket number and verify if the issue was already addressed.
   - Switch to the **Playlist Timeline** tab in the side panel to see chronological playlist publish versions and identify when the previous version was published.

### Scenario D: ATOM sync failing
1. `curl -s localhost:3001/api/sync/status` → read `lastSyncError` and `atom_auth` (`mode`, `expires_at`, `error`).
2. `401` or "sign-in expired" → the token expired. Get a new one, or use a refresh token or the API key ([`ATOM_INTEGRATION.md` §3.3](ATOM_INTEGRATION.md#33-getting-a-token-by-hand-until-the-api-key-exists)).
3. `Token refresh failed (401)` → `ATOM_REFRESH_TOKEN` holds an `eyJ…` access token, or a rotated/revoked refresh token. Move the `eyJ…` value to `ATOM_BEARER_TOKEN`, or get a fresh refresh token.
4. `ENOTFOUND` / `ETIMEDOUT` / `network error` → no route to ATOM (VPN or WARP, or DNS inside Docker).
5. Restart the backend after editing `backend/.env`; it is read only at startup.

### Scenario E: An alert in ATOM is missing from Sentinel
Check in order:
- Is the alert's `type` in the ingested list (`ATOM_ALERT_TYPES` / default)?
- `entity.product = CP`?
- `issue_start_time` within 72h, or upcoming?
- Is the feed monitored? `GET /api/atom/feeds/<feed_code>` → `monitored`, `data_only`, `headends[].health.monitoring`.
- Is the ATOM state filter set to "Open"? Resolved alerts are hidden by default.

### Scenario F: Playlist tab says "not allowed" / log shows playlist 403
The current ATOM role cannot read playlists. Sentinel skips those endpoints for 6h after a 403. This resolves once the service API key includes playlist read scope.
