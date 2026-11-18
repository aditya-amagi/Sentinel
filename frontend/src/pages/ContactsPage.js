import React, { useState, useEffect, useCallback } from 'react';
import './ContactsPage.css';

// ── Fixed alert types (mirrors backend alertTypes.js) ────────────────────────
// These are the only 4 types the system supports. Never dynamic.
const ALERT_TYPES = [
  { key: 'HOLE',              label: 'Hole in Playlist' },
  { key: 'NO_PLAYLIST',       label: 'No Playlist' },
  { key: 'DURATION_MISMATCH', label: 'Asset Duration Mismatch' },
  { key: 'MISSING_IN_CLOUD',  label: 'Missing in Cloud (Production)' },
];

const emptyConfig = () => ({
  customer_name:       '',
  product_version:     '',
  contact_email:       '',
  cc_emails:           '',
  use_general_for_all: true,
});

const emptyOverrides = () =>
  ALERT_TYPES.map(t => ({
    issue_type:    t.key,
    contact_email: '',
    cc_emails:     '',
    enabled:       false,
  }));

export default function ContactsPage() {
  const [feeds,        setFeeds]        = useState([]);
  const [selectedFeed, setSelectedFeed] = useState('');
  const [config,       setConfig]       = useState(emptyConfig());
  const [overrides,    setOverrides]    = useState(emptyOverrides());
  const [saving,       setSaving]       = useState(false);
  const [savedMsg,     setSavedMsg]     = useState('');
  const [loading,      setLoading]      = useState(false);
  const [atomFeed,     setAtomFeed]     = useState(null);

  // ── Fetch feed list ─────────────────────────────────────────────────────────
  const fetchFeeds = useCallback(async () => {
    try {
      const data = await (await fetch('/api/settings/feeds', { credentials: 'include' })).json();
      setFeeds(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  // ── Fetch config for selected feed ─────────────────────────────────────────
  const fetchConfig = useCallback(async (fc) => {
    setLoading(true);
    try {
      const data = await (await fetch(`/api/settings/contacts/${encodeURIComponent(fc)}`, { credentials: 'include' })).json();
      fetch(`/api/atom/feeds/${encodeURIComponent(fc)}`, { credentials: 'include' })
        .then(r => (r.ok ? r.json() : null)).then(setAtomFeed).catch(() => setAtomFeed(null));

      setConfig({
        customer_name:       data.config?.customer_name       || '',
        product_version:     data.config?.product_version     || '',
        contact_email:       data.config?.contact_email       || '',
        cc_emails:           data.config?.cc_emails           || '',
        use_general_for_all: data.config ? data.config.use_general_for_all !== 0 : true,
      });

      // Merge saved overrides into the full fixed list
      // DB stores rows keyed by issue_type = enum key
      const savedMap = {};
      for (const row of (data.overrides || [])) {
        savedMap[row.issue_type] = row;
      }

      setOverrides(ALERT_TYPES.map(t => {
        const saved = savedMap[t.key];
        return {
          issue_type:    t.key,
          contact_email: saved?.contact_email || '',
          cc_emails:     saved?.cc_emails     || '',
          enabled:       saved ? !!saved.enabled : false,
        };
      }));
    } catch (e) {
      console.error('fetchConfig error', e);
      setConfig(emptyConfig());
      setOverrides(emptyOverrides());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFeeds(); }, [fetchFeeds]);

  useEffect(() => {
    if (selectedFeed) fetchConfig(selectedFeed);
    else { setConfig(emptyConfig()); setOverrides(emptyOverrides()); }
  }, [selectedFeed, fetchConfig]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedFeed) return;
    setSaving(true); setSavedMsg('');
    try {
      const res = await fetch(`/api/settings/contacts/${encodeURIComponent(selectedFeed)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name:       config.customer_name,
          product_version:     config.product_version,
          contact_email:       config.contact_email,
          cc_emails:           config.cc_emails,
          use_general_for_all: config.use_general_for_all ? 1 : 0,
          overrides: overrides.map(o => ({
            issue_type:    o.issue_type,   // enum key
            contact_email: o.contact_email,
            cc_emails:     o.cc_emails,
            enabled:       o.enabled ? 1 : 0,
          })),
        }),
      });
      setSavedMsg(res.ok ? 'Configuration saved' : 'Error saving');
      if (res.ok) setTimeout(() => setSavedMsg(''), 3000);
    } catch {
      setSavedMsg('Error saving');
    } finally {
      setSaving(false);
    }
  };

  const updateOverride = (idx, field, val) =>
    setOverrides(prev => prev.map((o, i) => i === idx ? { ...o, [field]: val } : o));

  const activeOverrides = overrides.filter(o => o.enabled).length;

  return (
    <div className="contacts-page">
      <div className="cp-header">
        <div className="cp-title"><span className="cp-icon">✉</span> Contact Configuration</div>
        <p className="cp-subtitle">
          Manage Freshdesk contacts per feed. Supports general contacts and per-alert-type overrides
          for the 4 TOC alert types. Every other ATOM alert type uses the general contact.
        </p>
      </div>

      <div className="cp-body">
        {/* Feed selector */}
        <div className="cp-section">
          <label className="cp-label">Select Feed</label>
          <select
            className="cp-select"
            value={selectedFeed}
            onChange={e => setSelectedFeed(e.target.value)}
          >
            <option value="">— Select a feed —</option>
            {feeds.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          {feeds.length === 0 && (
            <p className="cp-hint">No feeds yet. Feeds appear once issues are synced from ATOM.</p>
          )}
        </div>

        {selectedFeed && loading && (
          <div className="cp-loading"><div className="mini-spinner" /> Loading…</div>
        )}

        {selectedFeed && !loading && (
          <>
            <AtomFeedCard feed={atomFeed} feedCode={selectedFeed}
              onUseName={name => setConfig(c => ({ ...c, customer_name: name }))}
              currentName={config.customer_name} />
            {/* ── General Contacts ── */}
            <div className="cp-section cp-card">
              <div className="cp-card-title">General Contacts — {selectedFeed}</div>
              <div className="cp-fields">
                <Field
                  label="Customer Name"
                  placeholder="e.g. Blue Ant Media"
                  value={config.customer_name}
                  onChange={v => setConfig(c => ({ ...c, customer_name: v }))}
                />
                <Field
                  label="Product Version"
                  placeholder="e.g. 3.31"
                  value={config.product_version}
                  onChange={v => setConfig(c => ({ ...c, product_version: v }))}
                />
                <Field
                  label="Contact Email"
                  placeholder="requester@customer.com"
                  type="email"
                  value={config.contact_email}
                  onChange={v => setConfig(c => ({ ...c, contact_email: v }))}
                />
                <Field
                  label="CC Emails"
                  placeholder="cc1@example.com, cc2@example.com"
                  value={config.cc_emails}
                  hint="Comma-separated"
                  onChange={v => setConfig(c => ({ ...c, cc_emails: v }))}
                />
              </div>

              <div className="cp-toggle-row">
                <div className="cp-toggle-info">
                  <span className="cp-toggle-label">Use general contacts for all alert types</span>
                  <span className="cp-toggle-hint">
                    {config.use_general_for_all
                      ? 'All 4 alert types use the contacts above'
                      : `Issue overrides active${activeOverrides > 0 ? ` (${activeOverrides} enabled)` : ' — none enabled yet'}`}
                  </span>
                </div>
                <Toggle
                  value={config.use_general_for_all}
                  onChange={v => setConfig(c => ({ ...c, use_general_for_all: v }))}
                />
              </div>
            </div>

            {/* ── Issue-Specific Overrides ── */}
            {!config.use_general_for_all && (
              <div className="cp-section cp-card">
                <div className="cp-card-title">Alert Type Contact Overrides</div>
                <p className="cp-card-hint">
                  When enabled, these contacts override the general contacts for that alert type.
                  Applies only to customer tickets — internal tickets always use the Amagi address.
                </p>

                <div className="cp-overrides-table">
                  <div className="cp-ov-header">
                    <span>Alert Type</span>
                    <span>Enable</span>
                    <span>Contact Email</span>
                    <span>CC Emails</span>
                  </div>

                  {ALERT_TYPES.map((alertType, idx) => {
                    const ov = overrides[idx];
                    return (
                      <div key={alertType.key} className={`cp-ov-row ${ov?.enabled ? 'enabled' : ''}`}>
                        <div className="cp-ov-type-cell">
                          <span className="cp-ov-type">{alertType.label}</span>
                          <span className="cp-ov-key">{alertType.key}</span>
                        </div>
                        <div className="cp-ov-toggle">
                          <Toggle
                            value={ov?.enabled || false}
                            onChange={v => updateOverride(idx, 'enabled', v)}
                            small
                          />
                        </div>
                        <input
                          className={`cp-ov-input ${!ov?.enabled ? 'disabled' : ''}`}
                          type="email"
                          placeholder={ov?.enabled ? 'override@example.com' : 'Enable to set'}
                          value={ov?.contact_email || ''}
                          disabled={!ov?.enabled}
                          onChange={e => updateOverride(idx, 'contact_email', e.target.value)}
                        />
                        <input
                          className={`cp-ov-input ${!ov?.enabled ? 'disabled' : ''}`}
                          placeholder={ov?.enabled ? 'cc1@ex.com, cc2@ex.com' : '—'}
                          value={ov?.cc_emails || ''}
                          disabled={!ov?.enabled}
                          onChange={e => updateOverride(idx, 'cc_emails', e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* Resolution preview */}
                <div className="cp-resolution-preview">
                  <div className="crp-title">Contact Resolution Order (Customer Ticket)</div>
                  <div className="crp-chain">
                    <span className="crp-step">Internal override (amagisupportcontact@amagi.com)</span>
                    <span className="crp-arrow">↓ only if Customer Ticket</span>
                    <span className="crp-step active">Issue override (if enabled above)</span>
                    <span className="crp-arrow">↓ fallback</span>
                    <span className="crp-step">General contacts ({config.contact_email || 'not set'})</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Save ── */}
            <div className="cp-save-row">
              <button className="cp-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Configuration'}
              </button>
              {savedMsg && (
                <span className={`cp-save-msg ${savedMsg.includes('Error') ? 'err' : 'ok'}`}>
                  {savedMsg.includes('Error') ? '✗' : '✓'} {savedMsg}
                </span>
              )}
            </div>

            {/* ── Internal ticket notice ── */}
            <div className="cp-section cp-info-box">
              <span className="cp-info-icon">ℹ</span>
              <div>
                <div className="cp-info-title">Internal Ticket always overrides contacts</div>
                <div className="cp-info-text">
                  Selecting <strong>Internal Ticket</strong> in the create modal ignores all
                  configuration above and sends to <code>amagisupportcontact@amagi.com</code>
                  with customer name "Internal - Amagi".
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, type = 'text', hint }) {
  return (
    <div className="cp-field">
      <label className="cp-field-label">{label}</label>
      <input
        className="cp-field-input"
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {hint && <span className="cp-field-hint">{hint}</span>}
    </div>
  );
}

function Toggle({ value, onChange, small }) {
  return (
    <button
      className={`cp-toggle ${value ? 'on' : ''} ${small ? 'small' : ''}`}
      onClick={() => onChange(!value)}
      type="button"
    >
      <span className="cp-toggle-thumb" />
    </button>
  );
}

// ── Read-only feed facts synced from ATOM's customer catalog ─────────────────
function AtomFeedCard({ feed, feedCode, onUseName, currentName }) {
  if (!feed) {
    return (
      <div className="cp-section cp-card atom-card empty">
        <div className="cp-card-title">In ATOM</div>
        <p className="cp-hint">{feedCode} isn't in the ATOM catalog yet. It is fetched on the next sync after an alert arrives for it.</p>
      </div>
    );
  }
  const rows = [
    ['Feed name', feed.feed_name],
    ['Customer', feed.customer_name],
    ['Automation', feed.automation_url],
    ['Account', feed.account_domain],
    ['Timezone', feed.time_zone],
    ['Broadcast day starts', feed.broadcast_start_time],
    ['Days monitored', feed.days_to_monitor],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  return (
    <div className="cp-section cp-card atom-card">
      <div className="cp-card-title">In ATOM <span className="atom-synced">synced {feed.synced_at ? new Date(feed.synced_at.replace(' ', 'T') + 'Z').toLocaleString() : '—'}</span></div>
      <dl className="atom-kv">
        {rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}
      </dl>
      {feed.headends?.length > 0 && (
        <div className="atom-headends">
          {feed.headends.map(h => (
            <span key={h.code} className={`atom-headend ${h.active === false ? 'standby' : ''}`}>
              {h.name || h.code}{h.active === false ? ' · standby' : ''}
            </span>
          ))}
        </div>
      )}
      {feed.customer_name && feed.customer_name !== currentName && (
        <button className="atom-use" onClick={() => onUseName(feed.customer_name)}>
          Use “{feed.customer_name}” as customer name
        </button>
      )}
    </div>
  );
}
