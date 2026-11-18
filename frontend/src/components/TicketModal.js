import React, { useState, useEffect, useRef } from 'react';
import { SREBus } from './SRETerminal';
import { SeverityPill } from './Pills';
import { alertLabel, fmtShort } from '../lib/alerts';
import { api } from '../lib/api';
import { useAppConfig } from '../hooks/useAppConfig';
import './TicketModal.css';

const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

/**
 * Create a Freshdesk ticket, or follow up on the existing one.
 * mode: 'create' | 'followup'  (follow-up is offered only when `parentTicket` exists)
 */
export default function TicketModal({ issue, feed, parentTicket, initialMode, onClose, onCreated }) {
  const { atom_writeback } = useAppConfig();
  const [mode, setMode] = useState(initialMode === 'followup' && parentTicket ? 'followup' : 'create');

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!issue) return null;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box wide" role="dialog" aria-modal="true" aria-label={mode === 'followup' ? 'Follow up on ticket' : 'Create Freshdesk ticket'}>
        <div className="modal-header">
          <div className="modal-title">
            {mode === 'followup' ? `Follow up on ${parentTicket.ticket_number || `#${parentTicket.freshdesk_id}`}` : 'Create Freshdesk ticket'}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {parentTicket && (
          <div className="mode-switch" role="tablist">
            <button role="tab" aria-selected={mode === 'followup'} className={mode === 'followup' ? 'on' : ''} onClick={() => setMode('followup')}>
              Follow up on {parentTicket.ticket_number || `#${parentTicket.freshdesk_id}`}
            </button>
            <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>
              New ticket
            </button>
          </div>
        )}

        <div className="modal-context">
          <Ctx label="Channel" mono value={<>{issue.feed_code}{(feed?.feed_name || issue.feed_name) ? <span className="mc-sub"> · {feed?.feed_name || issue.feed_name}</span> : null}</>} />
          <Ctx label="Alert" value={alertLabel(issue.issue_type)} />
          {issue.severity && <Ctx label="Severity" value={<SeverityPill severity={issue.severity} />} />}
          <Ctx label="Broadcast date" mono value={issue.playlist_date || '—'} />
        </div>

        {mode === 'create'
          ? <CreatePane issue={issue} atomWriteback={atom_writeback} onClose={onClose} onCreated={onCreated} />
          : <FollowupPane issue={issue} parentTicket={parentTicket} atomWriteback={atom_writeback} onClose={onClose} onCreated={onCreated} />}
      </div>
    </div>
  );
}

function Ctx({ label, value, mono }) {
  return (
    <div className="mc-row">
      <span className="mc-label">{label}</span>
      <span className={`mc-val ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}

/** Sandboxed render of the exact email body (no scripts, no same-origin access). */
function EmailPreview({ html }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:16px;background:#fff;}</style></head><body>${html || ''}</body></html>`;
  return <iframe className="email-preview" title="Email preview" sandbox="allow-popups" srcDoc={doc} />;
}

// ── New ticket ────────────────────────────────────────────────────────────────

function CreatePane({ issue, atomWriteback, onClose, onCreated }) {
  const [ticketType, setTicketType] = useState('customer');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let off = false;
    setLoading(true); setError('');
    api('/api/freshdesk/preview', { method: 'POST', body: { atom_issue_id: issue.atom_issue_id, playlist_id: issue.playlist_id, ticket_type: ticketType } })
      .then(d => { if (!off) { setPreview(d); SREBus.logFD({ type: 'preview', data: { feed: issue.feed_code, type: ticketType, subject: d.subject, email: d.email } }); } })
      .catch(e => { if (!off) setError(e.message); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [ticketType, issue.atom_issue_id, issue.playlist_id]); // eslint-disable-line

  const create = async () => {
    setCreating(true); setError('');
    try {
      SREBus.logFD({ type: 'request', data: { feed: issue.feed_code, ticketType } });
      const data = await api('/api/freshdesk/create', { method: 'POST', body: { atom_issue_id: issue.atom_issue_id, playlist_id: issue.playlist_id, ticket_type: ticketType } });
      SREBus.logFD({ type: 'response', data: { ticket: data.ticket_number, url: data.ticket_url, mock: data.mock } });
      onCreated && onCreated(data);
      onClose();
    } catch (e) {
      SREBus.logError({ message: `FD create failed: ${e.message}` });
      setError(e.message); setCreating(false);
    }
  };

  return (
    <>
      <div className="modal-section">
        <div className="modal-section-label">Ticket type</div>
        <div className="ticket-type-options">
          <TypeOption selected={ticketType === 'customer'} onSelect={() => setTicketType('customer')}
            label="Customer ticket" desc="To the customer contact configured for this feed" />
          <TypeOption selected={ticketType === 'internal'} onSelect={() => setTicketType('internal')}
            label="Internal ticket" desc="To amagisupportcontact@amagi.com, with technical details" />
        </div>
      </div>

      <div className="modal-section">
        <div className="modal-section-label">
          Email preview
          {preview?.is_mock && <span className="mock-badge">Mock mode — no Freshdesk credentials</span>}
        </div>
        {loading && <div className="modal-loading"><div className="mini-spinner" /> Building preview…</div>}
        {!loading && preview && (
          <>
            <div className="preview-box">
              <PreviewRow label="Subject" value={preview.subject} mono />
              <PreviewRow label="To" value={preview.email || '— no contact configured'} warn={!preview.email} />
              {preview.cc_emails?.length > 0 && <PreviewRow label="CC" value={preview.cc_emails.join(', ')} />}
              {preview.priority && <PreviewRow label="Priority" value={`${PRIORITY[preview.priority] || preview.priority}${preview.priority_reason && preview.priority_reason !== 'default' ? ` — ${preview.priority_reason}` : ''}`} />}
              {preview.covers > 1 && <PreviewRow label="Covers" value={`${preview.covers} open alerts of this type on this channel and day — all will be marked Ticketed`} />}
            </div>
            <EmailPreview html={preview.description} />
          </>
        )}
      </div>

      {!loading && preview && !preview.email && ticketType === 'customer' && (
        <div className="modal-warn-box">
          <span>⚠</span>
          <span>No contact email for <strong>{issue.feed_code}</strong>. Add one in <a href="#/settings/contacts" onClick={onClose}>Contacts &amp; feeds</a> before creating a customer ticket.</span>
        </div>
      )}
      {atomWriteback && <div className="modal-note">A comment with the ticket number and link will be added to each covered ATOM alert.</div>}
      {error && <div className="modal-error">✗ {error}</div>}

      <div className="modal-footer">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={creating || loading || !preview}>
          {creating ? 'Creating…' : `Create ${ticketType} ticket`}
        </button>
      </div>
    </>
  );
}

// ── Follow-up ─────────────────────────────────────────────────────────────────

function FollowupPane({ issue, parentTicket, atomWriteback, onClose, onCreated }) {
  const [template, setTemplate] = useState(null);   // null = use the server's suggestion
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoading(true); setError('');
      api('/api/freshdesk/followup/preview', { method: 'POST', log: false,
        body: { atom_issue_id: issue.atom_issue_id, playlist_id: issue.playlist_id, template: template || undefined, message: note } })
        .then(d => { setPreview(d); if (!template) setTemplate(d.template); })
        .catch(e => setError(e.message))
        .finally(() => setLoading(false));
    }, note ? 350 : 0);
    return () => clearTimeout(timer.current);
  }, [template, note, issue.atom_issue_id, issue.playlist_id]); // eslint-disable-line

  const send = async () => {
    setSending(true); setError('');
    try {
      const data = await api('/api/freshdesk/followup', { method: 'POST',
        body: { atom_issue_id: issue.atom_issue_id, playlist_id: issue.playlist_id, template, message: note } });
      SREBus.logFD({ type: 'followup', data: { parent: data.parent, number: data.number, template, mock: data.mock } });
      onCreated && onCreated({ ...data, followup: true, ticket_number: `${data.parent} · follow-up ${data.number}` });
      onClose();
    } catch (e) { setError(e.message); setSending(false); }
  };

  const customEmpty = template === 'custom' && !note.trim();

  return (
    <>
      <div className="modal-section">
        <div className="modal-section-label">
          Message
          {preview && <span className="fu-meta">Ticket raised {fmtShort(preview.parent.created_at && `${String(preview.parent.created_at).replace(' ', 'T')}Z`)} · {preview.followups_sent} follow-up{preview.followups_sent === 1 ? '' : 's'} sent</span>}
        </div>
        <div className="fu-templates" role="radiogroup" aria-label="Follow-up message">
          {(preview?.templates || []).map(t => (
            <button key={t.key} role="radio" aria-checked={template === t.key} className={`fu-card ${template === t.key ? 'on' : ''}`} onClick={() => setTemplate(t.key)}>
              <span className="fu-card-top">
                <span className="fu-label">{t.label}</span>
                {preview.suggested === t.key && <span className="fu-suggested">Suggested</span>}
              </span>
              <span className="fu-desc">{t.desc}</span>
            </button>
          ))}
        </div>
        <label className="fu-note-label" htmlFor="fu-note">{template === 'custom' ? 'Your message' : 'Add a note (optional)'}</label>
        <textarea id="fu-note" className="fu-note" rows={3} value={note} onChange={e => setNote(e.target.value)}
          placeholder={template === 'custom' ? 'Write the follow-up…' : 'e.g. Please call the TOC desk if you need help.'} />
      </div>

      <div className="modal-section">
        <div className="modal-section-label">
          Email preview{preview?.covers > 1 ? ` · covers ${preview.covers} alerts on this ticket` : ''}
          {preview?.is_mock && <span className="mock-badge">Mock mode — no Freshdesk credentials</span>}
        </div>
        {loading && !preview && <div className="modal-loading"><div className="mini-spinner" /> Building preview…</div>}
        {preview && <EmailPreview html={preview.html} />}
      </div>

      <div className="modal-note">
        Sent as a reply on {parentTicket.ticket_number || `#${parentTicket.freshdesk_id}`}, so it reaches the same recipients.
        {atomWriteback ? ' A note is also added to the ATOM alert.' : ''}
      </div>
      {error && <div className="modal-error">✗ {error}</div>}

      <div className="modal-footer">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={send} disabled={sending || !preview || customEmpty}>
          {sending ? 'Sending…' : 'Send follow-up'}
        </button>
      </div>
    </>
  );
}

function TypeOption({ selected, onSelect, label, desc }) {
  return (
    <button type="button" className={`type-option ${selected ? 'selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <span className="to-radio"><span className={`to-dot ${selected ? 'on' : ''}`} /></span>
      <span className="to-text">
        <span className="to-label">{label}</span>
        <span className="to-desc">{desc}</span>
      </span>
    </button>
  );
}

function PreviewRow({ label, value, mono, warn }) {
  return (
    <div className={`preview-row ${warn ? 'warn' : ''}`}>
      <span className="pr-label">{label}</span>
      <span className={`pr-val ${mono ? 'mono' : ''} ${warn ? 'warn' : ''}`}>{value}</span>
    </div>
  );
}
