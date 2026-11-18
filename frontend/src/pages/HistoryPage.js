import React, { useState, useEffect, useCallback } from 'react';
import IssueDetail from '../components/IssueDetail';
import './HistoryPage.css';

// Fixed alert type labels
import { alertLabel } from '../lib/alerts';
import { SeverityPill, AtomStatePill } from '../components/Pills';

function fmtDT(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB',{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}

export default function HistoryPage({ region }) {
  const [feeds,          setFeeds]          = useState([]);
  const [selectedFeed,   setSelectedFeed]   = useState(null);
  const [playlists,      setPlaylists]      = useState([]);
  const [selectedPL,     setSelectedPL]     = useState(null); // playlist row
  const [plIssues,       setPlIssues]       = useState([]);
  const [plLoading,      setPlLoading]      = useState(false);
  const [selectedKey,    setSelectedKey]    = useState(null); // { atomIssueId, playlistId }
  const [feedSearch,     setFeedSearch]     = useState('');

  const fetchFeeds = useCallback(async () => {
    try {
      const p = region ? `?region=${region}` : '';
      const data = await (await fetch(`/api/history/feeds${p}`, { credentials: 'include' })).json();
      setFeeds(Array.isArray(data) ? data : []);
    } catch {}
  }, [region]);

  const fetchPlaylists = useCallback(async (feed_code) => {
    setPlaylists([]); setSelectedPL(null); setPlIssues([]); setSelectedKey(null);
    try {
      const p = new URLSearchParams({ feed_code });
      if (region) p.set('region', region);
      const data = await (await fetch(`/api/history/playlists?${p}`, { credentials: 'include' })).json();
      setPlaylists(Array.isArray(data) ? data : []);
    } catch {}
  }, [region]);

  const fetchPlaylistIssues = useCallback(async (feed_code, playlist_id) => {
    setPlLoading(true); setSelectedKey(null);
    try {
      const data = await (await fetch(`/api/history/issues?feed_code=${feed_code}&playlist_id=${playlist_id}`, { credentials: 'include' })).json();
      setPlIssues(Array.isArray(data) ? data : []);
    } catch {}
    finally { setPlLoading(false); }
  }, []);

  useEffect(() => { fetchFeeds(); setSelectedFeed(null); setPlaylists([]); setSelectedPL(null); setPlIssues([]); }, [fetchFeeds]);

  const handleFeedSelect = (f) => {
    setSelectedFeed(f.feed_code);
    fetchPlaylists(f.feed_code);
  };

  const handlePlaylistSelect = (pl) => {
    setSelectedPL(pl);
    fetchPlaylistIssues(selectedFeed, pl.playlist_id);
  };

  const filteredFeeds = feeds.filter(f => f.feed_code.toLowerCase().includes(feedSearch.toLowerCase()));
  const REGION_COLOR = { APAC:'teal', US:'blue', EMEA:'purple' };

  return (
    <div className="history-page">
      {/* Feed list */}
      <div className="hist-feeds-col">
        <div className="hist-col-header">
          <span>Feeds</span>
          <span className="hist-count">{feeds.length}</span>
        </div>
        <div className="hist-search-wrap">
          <input className="hist-search" placeholder="Search feed…" value={feedSearch} onChange={e=>setFeedSearch(e.target.value)} />
        </div>
        <div className="hist-feed-list">
          {filteredFeeds.map(f => (
            <button
              key={f.feed_code}
              className={`hist-feed-item ${selectedFeed===f.feed_code?'active':''}`}
              onClick={() => handleFeedSelect(f)}
            >
              <span className="hist-feed-code mono">{f.feed_code}</span>
              {f.region && <span className={`hist-region-badge rc-${REGION_COLOR[f.region]||'amber'}`}>{f.region}</span>}
            </button>
          ))}
          {filteredFeeds.length===0 && <div className="hist-empty-msg">No feeds in history</div>}
        </div>
      </div>

      {/* Playlist list */}
      <div className="hist-playlists-col">
        <div className="hist-col-header">
          <span>{selectedFeed || 'Select a feed'}</span>
          {selectedFeed && <span className="hist-count">{playlists.length}</span>}
        </div>
        <div className="hist-pl-list">
          {!selectedFeed && <div className="hist-empty-msg">← Select a feed to browse playlists</div>}
          {playlists.map(pl => (
            <button
              key={pl.playlist_id}
              className={`hist-pl-item ${selectedPL?.playlist_id===pl.playlist_id?'active':''}`}
              onClick={() => handlePlaylistSelect(pl)}
            >
              <div className="hist-pl-main">
                <span className="hist-pl-time mono">{fmtDT(pl.playlist_start_time) || fmtDate(pl.playlist_date)}</span>
                <span className="hist-pl-id mono text-muted">#{pl.playlist_id}</span>
              </div>
              <div className="hist-pl-badges">
                <span className="hist-pl-badge issues">{pl.issue_count} alert{pl.issue_count!==1?'s':''}</span>
                {pl.penalty_count>0 && <span className="hist-pl-badge penalty">P:{pl.penalty_count}</span>}
                {pl.ticketed_count>0 && <span className="hist-pl-badge ticketed">T:{pl.ticketed_count}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Issues for selected playlist + detail panel */}
      <div className="hist-issues-col">
        <div className="hist-col-header">
          {selectedPL
            ? <><span>Alerts</span><span className="hist-count">{plIssues.length}</span></>
            : <span>Select a playlist</span>
          }
        </div>
        <div className="hist-issues-body">
          <div className={`hist-issues-list ${selectedKey?'has-sidebar':''}`}>
            {!selectedPL && <div className="hist-empty-msg">← Select a playlist to view alerts</div>}
            {plLoading && <div className="hist-loading"><div className="loading-spinner"/></div>}
            {!plLoading && selectedPL && plIssues.length===0 && <div className="hist-empty-msg">No alerts for this playlist</div>}
            {!plLoading && plIssues.map(iss => (
              <HistoryIssueRow
                key={`${iss.atom_issue_id}-${iss.playlist_id}`}
                issue={iss}
                selected={selectedKey?.atomIssueId===iss.atom_issue_id && selectedKey?.playlistId===iss.playlist_id}
                onClick={() => setSelectedKey({ atomIssueId: iss.atom_issue_id, playlistId: iss.playlist_id })}
              />
            ))}
          </div>
          {selectedKey && (
            <div className="hist-detail-panel">
              <IssueDetail
                atomIssueId={selectedKey.atomIssueId}
                playlistId={selectedKey.playlistId}
                onClose={() => setSelectedKey(null)}
                onUpdate={() => {}}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryIssueRow({ issue, selected, onClick }) {
  const fmtT = ts => ts ? new Date(ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '—';
  return (
    <div className={`hist-issue-row ${selected?'selected':''} ${issue.has_previous_ticket_same_day?'has-warning':''}`} onClick={onClick}>
      <div className="hir-left">
        <span className={`hir-dot ${issue.acknowledged?'ack':'open'}`}/>
        <div className="hir-info">
          <span className="hir-type">{alertLabel(issue.issue_type)}</span>
          {issue.asset_id && <span className="hir-asset mono">{issue.asset_id}</span>}
        </div>
      </div>
      <div className="hir-right">
        {issue.severity && <SeverityPill severity={issue.severity} compact />}
        <AtomStatePill issue={issue} />
        {issue.has_previous_ticket_same_day && <span className="hir-warn-badge" title="Previous playlist had ticket">⚠</span>}
        {issue.ticket_id && <span className="hir-ticket mono">{issue.ticket_id}</span>}
        <span className="hir-count">{issue.occ_count||0}</span>
        <span className="hir-time mono">{fmtT(issue.first_occurrence)}</span>
      </div>
    </div>
  );
}
