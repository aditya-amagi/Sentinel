# Freshdesk Tickets & Follow-ups

> **Code**: `backend/ticketText.js` (all wording) · `backend/db.js` (`buildFreshdeskPayload`, `getRelatedOpenAlerts`, `getParentTicket`) · `backend/server.js` (routes) · `backend/freshdeskApi.js` (`createTicket`, `replyToTicket`) · `frontend/src/components/TicketModal.js`
> **Last updated**: 2026-11-18

---

## 1. What a ticket contains

Every customer ticket answers, in this order: **what is wrong → what happens on air → when → what to do → where to click**.

| Block | Example (hole on CazeTV 3) |
|---|---|
| Greeting | `Dear livemode Team,` (configured customer name → ATOM customer name → `Dear Customer,`) |
| What + impact | "We are raising this ticket on your behalf. There is an unfilled gap (hole) in the published playlist for **CazeTV 3 (CAZE3)**. If the gap is not filled, **rescue content will go on-air** for its full duration." |
| Time to air (highlighted) | "**Airs at 2026-11-17 08:46:30 UTC / 2026-11-17 14:16:30 IST**, 1 h 47 min from now." On-air now and already-aired variants exist too |
| What we need from you | Numbered steps per alert type, always ending "Reply to this ticket once it is done…" |
| Details table | Channel (name + code), Customer, Broadcast date, Playlist ID(s), timing UTC + channel-local, Duration (hh:mm:ss), Asset ID, Automation URL (link), **Open in CloudPort** (direct playlist link), ATOM details |
| Affected items | When the ticket covers several alerts: one row each (UTC, local, duration, asset), plus **total hole duration** |
| What happens next | "We keep monitoring this channel. As soon as the fix is published our alert clears automatically and we will confirm it on this ticket." |
| Sign-off | `Amagi TOC Team · 24×7 Broadcast Operations` |
| Reference | Small grey line with the ATOM alert IDs |

**Internal tickets** open with "Hi team, Raising this internally for investigation…" and add a **Technical details** table: severity, ATOM alert name/type/IDs/state, AMG ID, headend, product/service, dedup key.

All ATOM-supplied text is HTML-escaped. Styling is inline, because email clients strip `<style>`.

### Compared with the competitor's ticket (Nov 2026)

| | Competitor | Sentinel |
|---|---|---|
| Action requested | One sentence | Numbered steps per alert type + "reply when done" |
| Time to air | — | Highlighted, with time remaining; marked urgent when on-air or within 2h |
| Times | UTC + local | UTC + channel-local (feed timezone from ATOM) |
| Several timings in one ticket | ✓ | ✓, plus a per-item table and total duration |
| Direct link to the playlist | Automation URL only | Automation URL **and** "Open in CloudPort" deep link |
| Alert types | Holes | Hole, no playlist, duration mismatch, missing in cloud, plus any ATOM fault (generic wording) |
| Priority | — | From severity; raised to Urgent when on-air or airing within 2h |
| Follow-ups | — | Templated, state-aware (§4) |

---

## 2. Wording per alert type

| Type | What | Impact | Steps |
|---|---|---|---|
| `HOLE` | Unfilled gap in the published playlist | Rescue content **will** go on-air for the gap | Fill the gap with programme/promo/filler → republish |
| `NO_PLAYLIST` | No playlist published for the broadcast day | Channel **will** air rescue content | Publish the playlist for that date (a draft may only need publishing) |
| `DURATION_MISMATCH` | Event's scheduled duration ≠ media duration | Programme may be cut short or leave a gap; rescue **may** air | Correct the duration or replace the media → republish |
| `MISSING_IN_CLOUD` | Scheduled media not in cloud storage | Rescue **will** play in its place if still missing at air time | Deliver the listed asset(s) or replace the events → republish if changed |
| any other ATOM type | "Our monitoring raised **{alert name}**" | ATOM's description | Review and correct |

Change the wording in `COPY` inside `ticketText.js`. Tests in `tests/ticketText.test.js` pin the key phrases.

---

## 3. Rules

- **Subject**: `TOC Alert [AM3] : {friendly type} - {channel name} ({feed}) - {broadcast date}`. Without a known channel name, it's just `{feed}`.
- **Priority** (Freshdesk 1–4): blocker/critical → 4, major → 3, minor → 2, dev → 1, unknown → 2. **Raised to 4** when the first affected time is on-air now or within 2 hours. The preview shows the reason, for example "Urgent — airs within 2 hours".
- **One ticket, all related alerts**: a ticket covers every **open, not-yet-ticketed** alert of the same type, feed and broadcast date (`getRelatedOpenAlerts`, up to 50), **plus every open alert in the same ATOM bucket** (`correlation_id`). The dashboard groups each bucket into one expandable row; ticketing from any alert in it covers the whole bucket. The preview shows "Covers N alerts". All covered alerts are stored against the ticket and become **Ticketed**. With ATOM write-back on, each covered ATOM alert gets the ticket comment.
- **Ticketed state**: creating a ticket now moves the issue to `ticketed`. Before Nov 2026 this never happened, so the Ticketed state was never reached.
- **Mock mode**: without `FRESHDESK_DOMAIN`/`FRESHDESK_API_KEY`, tickets are `INC-10001…` and nothing is sent.

---

## 4. Follow-ups

A follow-up is a **public reply on the original ticket** (`POST /api/v2/tickets/{id}/reply`), so it reaches the same requester and CCs. Each one is stored as a `freshdesk_tickets` row (`ticket_type = 'followup'`) and numbered per ticket.

### Templates

| Key | Use when | Opening line |
|---|---|---|
| `reminder` | No reply, still open, not imminent | "Following up on INC-123, raised 3 h ago, about … Our monitoring still shows the issue as **open**." + time to air + "Could you share an update, or an expected time for the fix?" |
| `urgent` | Still open and on-air now or within 2h | "**Urgent:** … is still not fixed." + "Unless it is fixed before then, **rescue content will air**." + "Please action this now…" |
| `aired` | The affected time passed while open | "…the issue was still open when it aired." + "Please let us know the cause…" |
| `resolved` | ATOM shows it cleared | "Good news… has cleared." + "No further action is needed… we will close this ticket." |
| `custom` | Anything else | Only the operator's text (required) |

Every follow-up adds:
- the operator's optional note (escaped);
- a status table: channel, broadcast date, status in our monitoring (Open / Open (acknowledged) / Resolved), next affected time or cleared-at time, CloudPort link;
- the sign-off and "Follow-up #n".

**Suggestion** (`suggestFollowup`), from the alert's live ATOM state:
1. All resolved → `resolved`.
2. Else on-air now or the next affected time within 2h → `urgent`.
3. Else every open item already aired → `aired`.
4. Otherwise → `reminder`.

### UI
When an issue has a ticket, the drawer's main button is **Follow up on INC-…**, with **New ticket** next to it. The modal offers template cards (the suggested one is marked), an optional note, and a live, sandboxed preview of the exact email. The Tickets tab lists follow-ups under their ticket.

### API (also the contract for the reply-detection bot)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/freshdesk/followup/preview` | `{atom_issue_id, playlist_id, template?, message?}` | `{template, suggested, templates[], html, parent:{ticket_number, freshdesk_id, ticket_url, created_at, ticket_type}, followups_sent, covers, is_mock}` |
| POST | `/api/freshdesk/followup` | `{atom_issue_id, playlist_id, template, message?}` | `{success, number, template, parent, mock, atom}` |

Errors:
- `400`: unknown template, or empty custom message.
- `404`: issue not found.
- `409`: the issue has no ticket yet.

With `ATOM_WRITEBACK=true`, a note `Sentinel: follow-up N (template) sent on Freshdesk INC-… by user@…` is added to the ATOM alert.

---

## 5. Next: reply-detection bot (planned)

The planned flow:
1. Watch open tickets for customer replies.
2. When none arrives within a window, prompt the TOC operator in chat with the suggested follow-up.
3. Send it automatically once the operator agrees.

Sentinel already provides:
- `getParentTicket()` and `freshdesk_tickets` hold every ticket and follow-up, with timestamps. Follow-up numbering is per ticket.
- `suggestFollowup()` picks the right message from live ATOM state.
- `POST /api/freshdesk/followup/preview` returns exactly what would be sent, for the chat prompt.
- `POST /api/freshdesk/followup` sends it. The bot calls this only after the operator agrees.

Still to build:
- **Reply detection**: `GET /api/v2/tickets/{id}/conversations` per open ticket. A conversation with `incoming: true` and `private: false`, newer than our last reply, counts as a customer reply. Store `last_customer_reply_at` and `last_followup_at` per ticket.
- **Rules**: no reply within N minutes (shorter when airing soon), at most M follow-ups, never after `resolved` unless sending the `resolved` template. Respect quiet hours if customers want them.
- **Chat app**: posts "INC-123 (CazeTV 3, hole, airs 14:16 IST) has no reply for 45 min — send *Airing soon* follow-up? [Send] [Edit] [Skip]". On Send it calls the follow-up endpoint and records who approved.
- **Audit**: keep who approved each automatic send, and the bot's decision inputs.
