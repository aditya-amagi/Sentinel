import React, { useState, useEffect } from 'react';
import { SREBus } from './SRETerminal';
import { SeverityPill } from './Pills';
import { alertLabel } from '../lib/alerts';
import { useAppConfig } from '../hooks/useAppConfig';
import './TicketModal.css';

const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

export default function TicketModal({ issue, feed, onClose, onCreated }) {
  const { atom_writeback } = useAppConfig();
  const [ticketType,  setTicketType]  = useState('customer');
  const [preview,     setPreview]     = useState(null);
  const [creating,    setCreating]    = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [error,       setError]       = useState('');

  useEffect(() => {
    if (!issue) return;
    loadPreview(ticketType);
  }, [ticketType, issue]); // eslint-disable-line

  const loadPreview = async (type) => {
    setLoadingPreview(true); setError('');
    try {
      const res = await fetch('/api/freshdesk/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          atom_issue_id: issue.atom_issue_id,
          playlist_id:   issue.playlist_id,
          ticket_type:   type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      SREBus.logFD({ type: 'preview', data: { feed: issue.feed_code, type, subject: data.subject, email: data.email } });
      setPreview(data);
    } catch (e) { setError(e.message); }
    finally { setLoadingPreview(false); }
  };

  const handleCreate = async () => {
    setCreating(true); setError('');
    try {
      const payload = { atom_issue_id: issue.atom_issue_id, playlist_id: issue.playlist_id, ticket_type: ticketType };
      SREBus.logFD({ type: 'request', data: { feed: issue.feed_code, ticketType } });
      const t0 = performance.now();
      const res = await fetch('/api/freshdesk/create', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const ms = Math.round(performance.now() - t0);
      const data = await res.json();
      SREBus.logTraffic({ method: 'POST', url: '/api/freshdesk/create', status: res.status, ms });
      if (!res.ok) {
        SREBus.logFD({ type: 'error', data: { error: data.error } });
        SREBus.logError({ message: `FD create failed: ${data.error}` });
        throw new Error(data.error);
      }
      SREBus.logFD({ type: 'response', data: { ticket: data.ticket_number, url: data.ticket_url, mock: data.mock } });
      onCreated && onCreated(data);
      onClose();
    } catch (e) { setError(e.message); setCreating(false); }
  };

  if (!issue) return null;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">

        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span className="modal-icon">🎫</span>
            Create Freshdesk Ticket
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Issue context */}
        <div className="modal-context">
          <div className="mc-row">
            <span className="mc-label">Feed</span>
            <span className="mc-val mono">{issue.feed_code}{feed?.feed_name ? <span className="mc-sub"> · {feed.feed_name}</span> : null}</span>
          </div>
          <div className="mc-row">
            <span className="mc-label">Issue</span>
            <span className="mc-val">{alertLabel(issue.issue_type)}</span>
          </div>
          {issue.severity && (
            <div className="mc-row">
              <span className="mc-label">Severity</span>
              <span className="mc-val"><SeverityPill severity={issue.severity} /></span>
            </div>
          )}
          <div className="mc-row">
            <span className="mc-label">Playlist</span>
            <span className="mc-val mono">{issue.playlist_id} · {issue.playlist_date}</span>
          </div>
          {issue.asset_id && (
            <div className="mc-row">
              <span className="mc-label">Asset</span>
              <span className="mc-val mono">{issue.asset_id}</span>
            </div>
          )}
        </div>

        {/* Ticket type selector */}
        <div className="modal-section">
          <div className="modal-section-label">Ticket Type</div>
          <div className="ticket-type-options">
            <TypeOption
              value="customer"
              selected={ticketType === 'customer'}
              onSelect={() => setTicketType('customer')}
              label="Customer Ticket"
              desc="Sent to the customer contact configured for this feed"
              icon="👤"
            />
            <TypeOption
              value="internal"
              selected={ticketType === 'internal'}
              onSelect={() => setTicketType('internal')}
              label="Internal Ticket"
              desc="Sent to amagisupportcontact@amagi.com — overrides all contacts"
              icon="🔒"
            />
          </div>
        </div>

        {/* Preview */}
        <div className="modal-section">
          <div className="modal-section-label">
            Preview
            {preview?.is_mock && <span className="mock-badge">MOCK MODE — No Freshdesk credentials set</span>}
          </div>
          {loadingPreview && <div className="modal-loading"><div className="mini-spinner"/> Building preview…</div>}
          {!loadingPreview && preview && (
            <div className="preview-box">
              <PreviewRow label="Subject"   value={preview.subject} mono />
              <PreviewRow label="To"        value={preview.email || '— (no contact configured)'} warn={!preview.email} />
              {preview.cc_emails?.length > 0 && (
                <PreviewRow label="CC" value={preview.cc_emails.join(', ')} />
              )}
              {preview.customer_name   && <PreviewRow label="Customer" value={preview.customer_name} />}
              {preview.priority        && <PreviewRow label="Priority" value={`${PRIORITY[preview.priority] || preview.priority} (from severity)`} />}
              {preview.product_version && <PreviewRow label="Version"  value={preview.product_version} />}
            </div>
          )}
          {!loadingPreview && !preview && !error && (
            <div className="modal-hint">Loading preview…</div>
          )}
        </div>

        {/* Missing contact warning */}
        {!loadingPreview && preview && !preview.email && ticketType === 'customer' && (
          <div className="modal-warn-box">
            <span>⚠</span>
            <span>No contact email configured for <strong>{issue.feed_code}</strong>.
              Go to <a href="#/settings/contacts" onClick={onClose}>Settings → Contacts</a> to add one before creating a customer ticket.</span>
          </div>
        )}

        {atom_writeback && (
          <div className="modal-note">A comment with the ticket number and link will be added to the ATOM alert.</div>
        )}

        {error && <div className="modal-error">✗ {error}</div>}

        {/* Footer */}
        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="modal-create-btn"
            onClick={handleCreate}
            disabled={creating || loadingPreview}
          >
            {creating ? 'Creating…' : `Create ${ticketType === 'internal' ? 'Internal' : 'Customer'} Ticket`}
          </button>
        </div>
      </div>
    </div>
  );
}

function TypeOption({ value, selected, onSelect, label, desc, icon }) {
  return (
    <div className={`type-option ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="to-radio"><span className={`to-dot ${selected ? 'on' : ''}`}/></span>
      <span className="to-icon">{icon}</span>
      <div className="to-text">
        <span className="to-label">{label}</span>
        <span className="to-desc">{desc}</span>
      </div>
    </div>
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
