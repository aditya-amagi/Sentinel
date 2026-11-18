# Sentinel: Operations, Configuration & Security Runbook

> **Target Audience**: DevOps, SREs, NOC Leads, Infrastructure Engineers  
> **Last Updated**: 2026-11-03  

---

## 1. Environment Configuration Reference

Configuration is managed via environment variables in `backend/.env` (or Docker environment overrides).

| Variable | Description | Required | Default / Example |
| :--- | :--- | :--- | :--- |
| `PORT` | HTTP server listening port | No | `3001` |
| `DB_PATH` | Path to primary SQLite database | No | `/app/data/atom_dashboard.db` (Docker) or `backend/atom_dashboard.db` |
| `FRONTEND_URL` | Base URL of frontend for CORS & post-auth redirects | No | `http://localhost:3000` |
| `DEMO_MODE` | Seeds fixed deterministic dataset on startup and halts ATOM polling | No | `false` (Set `true` for demo/testing) |
| `ATOM_BASE_URL` | ATOM API base incl. `/v1/api` — prod `https://am.amagi.tv/v1/api`, staging `https://am-staging.amagi.tv/v1/api` (Amagi users sign in via SSO; get a Bearer token from the web app or request an API key) | No | If empty, runs random mock generator |
| `ATOM_API_KEY` | ATOM API key, sent as `X-API-Key` | One auth option | — |
| `ATOM_BEARER_TOKEN` | Static ATOM JWT, sent as `Authorization: Bearer` (expires) | One auth option | — |
| `ATOM_EMAIL` / `ATOM_PASSWORD` | ATOM user login; token fetched from `/auth/user/login` and renewed | One auth option | — |
| `ATOM_ALERT_TYPES` | ATOM types to pull. Empty = built-in list (4 TOC types + fault types; excludes `asset_download_waiting`/`asset_submitted`/`asset_queued`). `*` = all | No | empty |
| `ATOM_ALERT_STATES` | ATOM states to pull (queried one at a time — prod has no `states` filter) | No | `active,snoozed` |
| `ATOM_LOOKBACK_HOURS` | Only alerts with `issue_start_time` ≥ now − N hours (upcoming always included). `0` = no window | No | `72` |
| `ATOM_RESOLVE_CHECKS_PER_SYNC` | `GET /alerts/{id}` checks per sync for alerts that dropped out (resolution detection) | No | `200` |
| `ATOM_PLAYLIST_LOOKUPS_PER_SYNC` | Published-playlist lookups per sync (each feed+date at most every 30 min) | No | `150` |
| `ATOM_PRODUCT` | `entity[product]` filter; empty = all products | No | `CP` |
| `ATOM_PAGE_SIZE` / `ATOM_MAX_PAGES` | Paging for `GET /alerts` (resolution detection is skipped when the page cap is hit) | No | `500` / `20` |
| `ATOM_CATALOG_REFRESH_HOURS` | Feed catalog refresh interval | No | `6` |
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

## 2. Urgent Security Notices & Remediation

> [!CAUTION]
> **CRITICAL SECURITY ADVISORY 01: EXPOSED FRESHDESK CREDENTIALS**  
> An active Freshdesk API key was detected committed to the repository in `backend/.env`.  
> - **Immediate Action**: Revoke the API key in Freshdesk admin immediately.  
> - **Remediation**: Issue a rotated key, store it in a secure secret manager (e.g. AWS Secrets Manager, HashiCorp Vault), and inject it into container environments at runtime. Remove all plaintext credentials from `.env` files tracked in git.

> [!WARNING]
> **SECURITY ADVISORY 02: COMMITTED DEPENDENCY DIRECTORIES**  
> `backend/node_modules` and `frontend/node_modules` were inadvertently checked into git history.  
> - **Impact**: Repository bloat (>4.6M lines in git history, sluggish git operations) and risk of tampered vendor packages.  
> - **Remediation**: Execute `git rm -r --cached */node_modules` and ensure `.gitignore` excludes them across all branches.

> [!WARNING]
> **BUG ADVISORY 03: NGINX CONFIGURATION MISSING AUTH PROXY**  
> In `frontend/nginx.conf`, only `/api/` is reverse-proxied to `backend:3001`. `/auth/` is not proxied, falling back to React's `index.html`. In Docker deployments, OneLogin SSO (`/auth/login`, `/auth/callback`, `/auth/me`) will fail with 404 or index HTML payload.  
> - **Remediation**: Add location block to `nginx.conf`:
>   ```nginx
>   location /auth/ {
>       proxy_pass http://backend:3001;
>       proxy_http_version 1.1;
>       proxy_set_header Host $host;
>       proxy_set_header X-Real-IP $remote_addr;
>   }
>   ```

---

## 3. How to Run Sentinel

### Quick Start via NPM (Local Development)

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
# Start both backend and frontend containers
docker-compose up --build -d

# Check container status
docker-compose ps

# View backend logs
docker-compose logs -f backend
```

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
