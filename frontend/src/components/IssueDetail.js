import React, { useState, useEffect, useCallback } from 'react';
import TicketModal from './TicketModal';
import AckButton from './AckButton';
import { SeverityPill, AtomStatePill, TriagePill, TypeLabel } from './Pills';
import { api, issuePath } from '../lib/api';
import { triageOf, fmtLong, fmtShort, fmtClock, fmtInZone, fmtDuration, relTime, isToc } from '../lib/alerts';
import './IssueDetail.css';

const TABS = [['overview', 'Overview'], ['playlist', 'Playlist'], ['activity', 'Activity'], ['tickets', 'Tickets']];

export default function IssueDetail({ atomIssueId, playlistId, onClose, onUpdate }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('overview');
  const [feed, setFeed]       = useState(null);
  const [fdTickets, setFd]    = useState([]);
  const [showModal, setModal] = useState(false);   // false | 'create' | 'followup'
  const [notice, setNotice]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = await api(`/api/issues/${encodeURIComponent(atomIssueId)}/playlist/${encodeURIComponent(playlistId)}`, { log: false });
      setData(json);
      api(`/api/freshdesk/tickets/${encodeURIComponent(atomIssueId)}/${encodeURIComponent(playlistId)}`, { log: false })
        .then(t => setFd(Array.isArray(t) ? t : [])).catch(() => setFd([]));
      if (json.issue?.feed_code) {
        api(`/api/atom/feeds/${encodeURIComponent(json.issue.feed_code)}`, { log: false }).then(setFeed).catch(() => setFeed(null));
      }
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [atomIssueId, playlistId]);

  useEffect(() => { setTab('overview'); setNotice(null); load(); }, [load]);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && !showModal) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showModal]);

  const onTriage = (updated, atom) => {
    setData(d => ({ ...d, issue: { ...d.issue, ...updated } }));
    onUpdate && onUpdate(updated);
    if (atom && atom.ok === false) setNotice({ tone: 'err', text: `Saved in Sentinel, but ATOM was not updated: ${atom.error}` });
    else if (atom && !atom.skipped) setNotice({ tone: 'ok', text: updated.consolidated_status === 'snoozed' ? `Snoozed in ATOM until ${fmtShort(updated.snoozed_until)}` : 'ATOM updated' });
    else setNotice(null);
  };

  if (loading && !data) return (
    <div className="dp"><div className="dp-head"><span /><CloseBtn onClick={onClose} /></div><div className="empty-state"><div className="loading-spinner" /></div></div>
  );
  if (!data?.issue) return (
    <div className="dp"><div className="dp-head"><span>Alert not found</span><CloseBtn onClick={onClose} /></div></div>
  );

  const { issue, occurrences = [], playlistTimeline = [], previousTicketDetail } = data;
  const state = triageOf(issue);
  const parentTicket = fdTickets.find(t => t.ticket_type !== 'followup' && t.freshdesk_id) || null;

  return (
    <div className="dp">
      <div className="dp-head">
        <div className="dp-head-main">
          <div className="dp-eyebrow">
            <span className={`dp-kind ${isToc(issue.issue_type) ? 'toc' : 'other'}`}>{isToc(issue.issue_type) ? 'TOC alert' : 'ATOM alert'}</span>
            <span className="mono">{issue.feed_code}</span>
            {issue.region && <span>· {issue.region}</span>}
          </div>
          <h2 className="dp-title"><TypeLabel type={issue.issue_type} rawType={issue.raw_type} /></h2>
          <div className="dp-pills">
            <TriagePill state={state} />
            <SeverityPill severity={issue.severity} />
            <AtomStatePill issue={issue} />
          </div>
        </div>
        <CloseBtn onClick={onClose} />
      </div>

      {issue.has_previous_ticket_same_day ? (
        <div className="dp-banner warn">
          <strong>Already ticketed today.</strong> A previous playlist version
          {issue.previous_playlist_time ? ` (${fmtShort(issue.previous_playlist_time)})` : ''} has ticket <b className="mono">{issue.previous_ticket_id}</b>.
          {previousTicketDetail?.ticket_link && <a href={previousTicketDetail.ticket_link} target="_blank" rel="noopener noreferrer"> View ↗</a>}
        </div>
      ) : null}
      {issue.atom_writeback_error && !notice && (
        <div className="dp-banner err"><strong>Last ATOM update failed.</strong> {issue.atom_writeback_error}</div>
      )}
      {notice && <div className={`dp-banner ${notice.tone}`}>{notice.text}</div>}

      <div className="dp-tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}{k === 'tickets' && fdTickets.length > 0 && <span className="dp-tab-count">{fdTickets.length}</span>}
          </button>
        ))}
      </div>

      <div className="dp-body">
        {tab === 'overview' && <Overview issue={issue} feed={feed} occurrences={occurrences} />}
        {tab === 'playlist' && <PlaylistTab issue={issue} timeline={playlistTimeline} occurrences={occurrences} feed={feed} />}
        {tab === 'activity' && <ActivityTab issue={issue} occurrences={occurrences} />}
        {tab === 'tickets'  && <TicketsTab tickets={fdTickets} onCreate={() => setModal('create')} onFollowup={() => setModal('followup')} />}
      </div>

      <div className="dp-actions">
        <AckButton issue={issue} onChange={onTriage} size="md" />
        {state === 'ticketed' && <span className="dp-locked">Ticketed — triage locked</span>}
        {parentTicket ? (
          <span className="dp-ticket-actions">
            <button className="btn" onClick={() => setModal('create')}>New ticket</button>
            <button className="btn primary" onClick={() => setModal('followup')}>
              Follow up on {parentTicket.ticket_number || `#${parentTicket.freshdesk_id}`}
            </button>
          </span>
        ) : (
          <button className="btn primary dp-create" onClick={() => setModal('create')}>Create Freshdesk ticket</button>
        )}
      </div>

      {showModal && (
        <TicketModal issue={issue} feed={feed} parentTicket={parentTicket} initialMode={showModal} onClose={() => setModal(false)}
          onCreated={result => {
            const atomNote = result.atom && !result.atom.skipped
              ? (result.atom.ok ? ' · noted in ATOM' : ` · ATOM note failed: ${result.atom.error}`) : '';
            const what = result.followup
              ? `Follow-up ${result.number} sent on ${result.parent}`
              : `Ticket ${result.ticket_number} created${result.covers > 1 ? ` for ${result.covers} alerts` : ''}`;
            setNotice({ tone: result.atom?.ok === false ? 'err' : 'ok', text: `${what}${result.mock ? ' (mock)' : ''}${atomNote}` });
            setTab('tickets');
            load();
            if (!result.followup) onUpdate && onUpdate({ ...issue, state: 'ticketed', ticket_id: result.ticket_number, ticket_link: result.ticket_url });
          }} />
      )}
    </div>
  );
}

function CloseBtn({ onClick }) {
  return <button className="dp-close" onClick={onClick} aria-label="Close details">✕</button>;
}

// ── Overview ────────────────────────────────────────────────────────────────

function Overview({ issue, feed, occurrences }) {
  const start = issue.earliest_scheduled || issue.playlist_start_time || occurrences[0]?.playout_start_time;
  const local = feed?.time_zone ? fmtInZone(start, feed.time_zone) : null;
  let labels = null;
  try { labels = issue.labels ? JSON.parse(issue.labels) : null; } catch {}

  return (
    <>
      {(issue.alert_name || issue.description) && (
        <section className="dp-card">
          {issue.alert_name && <div className="dp-alert-name">{issue.alert_name}</div>}
          {issue.description && <p className="dp-desc">{issue.description}</p>}
        </section>
      )}

      <section className="dp-section">
        <h3>When</h3>
        <dl className="kv">
          <KV k="Starts" v={<>{fmtLong(start)} <span className="kv-sub">UTC · {relTime(start)}</span></>} />
          {local && <KV k="Feed local" v={<>{local} <span className="kv-sub">{feed.time_zone}</span></>} />}
          <KV k="Duration" v={fmtDuration(issue.duration_ms)} />
          <KV k="Broadcast date" v={issue.playlist_date} mono />
          {issue.consolidated_status === 'snoozed' && <KV k="Snoozed" v={`until ${fmtShort(issue.snoozed_until)}${issue.snoozed_by ? ` by ${issue.snoozed_by}` : ''}`} />}
          {issue.consolidated_status === 'resolved' && <KV k="Resolved" v={`${fmtShort(issue.resolved_at)}${issue.resolved_by ? ` by ${issue.resolved_by}` : ''}`} />}
        </dl>
      </section>

      <section className="dp-section">
        <h3>Where</h3>
        <dl className="kv">
          <KV k="Feed" v={<>{issue.feed_code}{(feed?.feed_name || issue.feed_name) && <span className="kv-sub"> {feed?.feed_name || issue.feed_name}</span>}</>} mono />
          <KV k="Customer" v={feed?.customer_name} />
          <KV k="ATOM views" v={(() => { try { return JSON.parse(issue.atom_view_names || '[]').join(', '); } catch { return null; } })()} />
          <KV k="AMG ID" v={issue.amg_id || feed?.amg_id} mono />
          <KV k="Headend" v={issue.headend_code || issue.host} mono />
          <KV k="Automation" v={issue.automation_url || feed?.automation_url} mono />
          <KV k="Playlist" v={issue.playlist_id} mono />
          <KV k="Asset" v={issue.asset_id} mono />
        </dl>
        {issue.source_url && /^https:\/\//.test(issue.source_url) && (
          <a className="btn sm dp-source" href={issue.source_url} target="_blank" rel="noopener noreferrer">Open in CloudPort ↗</a>
        )}
        {feed?.headends?.length > 0 && (
          <div className="headends">
            {feed.headends.map(h => {
              const bad = h.health && Object.values(h.health).some(v => typeof v === 'string' && !/^(ok|healthy|up|true)$/i.test(v));
              return (
                <span key={h.code} className={`headend ${h.active === false ? 'inactive' : ''} ${bad ? 'bad' : 'good'}`}
                  title={h.health ? Object.entries(h.health).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') : 'No health data'}>
                  <span className="headend-dot" />{h.name || h.code}{h.active === false ? ' (standby)' : ''}
                </span>
              );
            })}
          </div>
        )}
      </section>

      <section className="dp-section">
        <h3>ATOM record</h3>
        <dl className="kv">
          <KV k="Alert ID" v={issue.atom_issue_id} mono />
          <KV k="Type" v={issue.raw_type || issue.issue_type} mono />
          <KV k="Product" v={[issue.product, issue.entity_service].filter(Boolean).join(' · ')} />
          <KV k="Dedup key" v={issue.dedup_key} mono />
          <KV k="Correlation" v={issue.correlation_id} mono />
          <KV k="Updated" v={issue.atom_updated_at && fmtShort(issue.atom_updated_at)} />
        </dl>
        {labels && Object.keys(labels).length > 0 && (
          <div className="labels">{Object.entries(labels).map(([k, v]) => <span key={k} className="label mono">{k}={String(v)}</span>)}</div>
        )}
      </section>
    </>
  );
}

function KV({ k, v, mono }) {
  if (v === null || v === undefined || v === '') return null;
  return (<><dt>{k}</dt><dd className={mono ? 'mono' : ''}>{v}</dd></>);
}

// ── Playlist ────────────────────────────────────────────────────────────────

function PlaylistTab({ issue, timeline, occurrences, feed }) {
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false;
    setCtx(null); setErr('');
    api(issuePath(issue, '/context'), { log: false }).then(d => { if (!off) setCtx(d); }).catch(e => { if (!off) setErr(e.message); });
    return () => { off = true; };
  }, [issue.atom_issue_id, issue.playlist_id]); // eslint-disable-line

  return (
    <>
      <section className="dp-section">
        <h3>At the alert time {ctx?.meta?.mock && <span className="kv-sub">(synthetic playlist — demo/mock mode)</span>}</h3>
        {!ctx && !err && <div className="empty-state compact"><div className="loading-spinner" /></div>}
        {err && <div className="dp-banner err">Couldn't load playlist from ATOM: {err}</div>}
        {ctx && !ctx.available && <div className="empty-state compact"><span className="empty-title">No published playlist</span><span>ATOM has no playlist for {issue.feed_code} on {issue.playlist_date}.</span></div>}
        {ctx?.available && (
          <div className="plc">
            {ctx.items.map((it, n) => {
              const gap = n > 0 && it.index - ctx.items[n - 1].index > 1;
              return (
                <React.Fragment key={it.index}>
                  {gap && <div className="plc-gap">⋯</div>}
                  <div className={`plc-row ${it.is_current ? 'current' : ''} ${it.is_asset_match ? 'match' : ''}`}>
                    <span className="plc-time mono">{fmtClock(it.start_time)}</span>
                    <div className="plc-main">
                      <span className="plc-title">{it.title || 'Untitled'}</span>
                      <span className="plc-sub mono">{[it.asset_id, it.type, fmtDuration(it.duration_ms)].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className={`plc-status s-${(it.status || 'unknown').toLowerCase()}`}>{it.status || '—'}</span>
                    {it.is_current && <span className="plc-flag">alert</span>}
                    {it.is_asset_match && !it.is_current && <span className="plc-flag match">asset</span>}
                  </div>
                </React.Fragment>
              );
            })}
            <div className="plc-foot">{ctx.total_items} items in playlist{ctx.playlist_id ? ` ${ctx.playlist_id}` : ''}{feed?.time_zone ? ` · times shown in your local time` : ''}</div>
          </div>
        )}
      </section>

      <section className="dp-section">
        <h3>Published versions <span className="kv-sub">{issue.playlist_date}</span></h3>
        {timeline.length === 0
          ? <div className="muted-line">No playlist versions recorded yet.</div>
          : <ol className="versions">
              {timeline.map((v, i) => {
                const next = timeline[i + 1];
                const s = new Date(v.published_at).getTime(), e = next ? new Date(next.published_at).getTime() : Infinity;
                const hits = occurrences.filter(o => { const t = new Date(o.playout_start_time).getTime(); return t >= s && t < e; }).length;
                const current = v.playlist_id === issue.playlist_id;
                return (
                  <li key={v.id || i} className={current ? 'current' : ''}>
                    <span className="v-dot" />
                    <span className="mono v-time">{fmtClock(v.published_at)}</span>
                    <span className="mono">#{v.playlist_id}</span>
                    <span className="v-tag">{i === 0 ? 'initial' : 'republished'}</span>
                    {current && <span className="v-tag cur">this alert</span>}
                    {hits > 0 && <span className="v-hits">{hits} occurrence{hits > 1 ? 's' : ''}</span>}
                  </li>
                );
              })}
            </ol>}
      </section>
    </>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ issue, occurrences }) {
  const [atom, setAtom] = useState(null);
  useEffect(() => {
    let off = false;
    api(`/api/atom/alerts/${encodeURIComponent(issue.atom_issue_id)}`, { log: false })
      .then(d => { if (!off) setAtom(d); }).catch(() => { if (!off) setAtom({ alert: null }); });
    return () => { off = true; };
  }, [issue.atom_issue_id]);
  const transitions = atom?.alert?.transitions || [];

  return (
    <>
      <section className="dp-section">
        <h3>ATOM lifecycle {atom?.source && atom.source !== 'atom' && <span className="kv-sub">from stored copy</span>}</h3>
        {!atom && <div className="empty-state compact"><div className="loading-spinner" /></div>}
        {atom && transitions.length === 0 && <div className="muted-line">No state changes recorded in ATOM.</div>}
        {transitions.length > 0 && (
          <ol className="feed-list">
            {transitions.map((t, i) => (
              <li key={i}>
                <span className={`fl-dot a-${t.action}`} />
                <div>
                  <div><b className="fl-action">{t.action}</b>{t.actor && <> by <span className="mono">{t.actor}</span></>}
                    {t.snooze_until && <span className="kv-sub"> until {fmtShort(t.snooze_until)}</span>}</div>
                  {t.note && <div className="fl-note">{t.note}</div>}
                  <div className="kv-sub">{fmtLong(t.timestamp)}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="dp-section">
        <h3>Occurrences <span className="kv-sub">{occurrences.length}</span></h3>
        {occurrences.length === 0
          ? <div className="muted-line">No occurrences for this playlist.</div>
          : <ol className="feed-list">
              {occurrences.map(o => (
                <li key={o.id}>
                  <span className="fl-dot occ" />
                  <div>
                    <div className="mono">{fmtLong(o.playout_start_time)}</div>
                    <div className="kv-sub">{[o.duration, o.asset_id, o.resolved_playlist_id && `PL ${o.resolved_playlist_id}`].filter(Boolean).join(' · ')}</div>
                  </div>
                </li>
              ))}
            </ol>}
      </section>
    </>
  );
}

// ── Tickets ─────────────────────────────────────────────────────────────────

function TicketsTab({ tickets, onCreate, onFollowup }) {
  if (!tickets.length) return (
    <div className="empty-state">
      <span className="empty-title">No tickets yet</span>
      <span>Create a customer or internal Freshdesk ticket for this alert.</span>
      <button className="btn primary" onClick={onCreate} style={{ marginTop: 8 }}>Create Freshdesk ticket</button>
    </div>
  );
  const ts = t => fmtShort(t.created_at && `${String(t.created_at).replace(' ', 'T')}Z`);
  const originals = tickets.filter(t => t.ticket_type !== 'followup');
  const followupsOf = t => tickets.filter(f => f.ticket_type === 'followup' && f.freshdesk_id === t.freshdesk_id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return (
    <section className="dp-section">
      <ul className="tickets">
        {originals.map(t => {
          const fus = followupsOf(t);
          return (
            <li key={t.id} className="ticket-block">
              <div className="ticket-head">
                <span className={`t-type ${t.ticket_type}`}>{t.ticket_type === 'internal' ? 'Internal' : 'Customer'}</span>
                <div className="t-main">
                  <span className="mono">{t.ticket_number || `FD-${t.freshdesk_id}`}</span>
                  <span className="kv-sub">{t.requester_email || 'no requester'} · {ts(t)}</span>
                </div>
                {t.ticket_url && <a className="btn sm" href={t.ticket_url} target="_blank" rel="noopener noreferrer">Open ↗</a>}
              </div>
              {fus.length > 0 && (
                <ol className="followups">
                  {fus.map((f, n) => (
                    <li key={f.id}><span className="fu-dot" />Follow-up {n + 1} · {String(f.subject || '').replace(/^Follow-up \d+ /, '').replace(/[()]/g, '') || 'sent'} · <span className="kv-sub">{ts(f)}</span></li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      <button className="btn" onClick={onFollowup} style={{ marginTop: 10 }}>Send a follow-up</button>
    </section>
  );
}
