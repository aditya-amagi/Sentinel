// SRETerminal.js — Hidden SRE debug console
// Activation: type "letmein" anywhere | Ctrl+` toggles | ESC closes
// Floating bottom-right, draggable, no visible UI trigger.

import React, {
  useState, useEffect, useRef, useCallback, useReducer,
} from 'react';
import './SRETerminal.css';

// ── Global log bus — other modules push into this ─────────────────────────────
const _bus = {
  traffic: [],    // { ts, method, url, status, ms }
  fd:      [],    // { ts, type, data }
  errors:  [],    // { ts, message, url }
  stateTransitions: [], // { ts, feed, from, to }
  perf:    [],    // { ts, label, ms }
};

export const SREBus = {
  logTraffic:    (entry) => { _bus.traffic.unshift({ ts: now(), ...entry }); if (_bus.traffic.length > 200) _bus.traffic.pop(); },
  logFD:         (entry) => { _bus.fd.unshift({ ts: now(), ...entry });      if (_bus.fd.length > 100)      _bus.fd.pop(); },
  logError:      (entry) => { _bus.errors.unshift({ ts: now(), ...entry });  if (_bus.errors.length > 100)  _bus.errors.pop(); },
  logState:      (entry) => { _bus.stateTransitions.unshift({ ts: now(), ...entry }); if (_bus.stateTransitions.length > 200) _bus.stateTransitions.pop(); },
  logPerf:       (entry) => { _bus.perf.unshift({ ts: now(), ...entry });    if (_bus.perf.length > 100)    _bus.perf.pop(); },
  getBus:        ()      => _bus,
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function tsMs() { return performance.now(); }
function fmt(obj) { return JSON.stringify(obj, null, 2); }
function fmtShort(obj) { return JSON.stringify(obj, null, 2).slice(0, 1200); }

// ── Shared state ref (injected by App.js via setSREContext) ───────────────────
let _ctx = {
  issues:      [],
  selectedKey: null,
  filters:     {},
  stats:       null,
  region:      null,
  lastFetch:   null,
  pollInterval: 30,
};
export function setSREContext(patch) { Object.assign(_ctx, patch); }

// ── Command registry ──────────────────────────────────────────────────────────
function runCommand(raw) {
  const trimmed = raw.trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const arg = args.join(' ');

  switch (cmd.toLowerCase()) {

    // ── Core ──
    case 'help': return HELP_TEXT;

    case 'clear': return '__CLEAR__';

    case 'close': return '__CLOSE__';

    case 'status': {
      const s = _ctx.stats || {};
      return [
        `Sentinel SRE Console`,
        `─────────────────────`,
        `Region:     ${_ctx.region || 'All'}`,
        `Issues:     ${_ctx.issues.length} loaded`,
        `Penalty:    ${s.state_penalty ?? '?'}`,
        `Ack:        ${s.state_ack ?? '?'}`,
        `Ticketed:   ${s.state_ticketed ?? '?'}`,
        `Total:      ${s.total ?? '?'}`,
        `Upcoming:   ${s.upcoming ?? '?'}`,
        `Last sync:  ${s.last_sync || '—'}`,
        `Sync status:${s.sync?.lastSyncStatus || '—'}`,
      ].join('\n');
    }

    case 'time': {
      const last = _ctx.lastFetch ? new Date(_ctx.lastFetch) : null;
      const next = last ? new Date(last.getTime() + _ctx.pollInterval * 1000) : null;
      return [
        `Poll interval: ${_ctx.pollInterval}s`,
        `Last fetch:    ${last ? last.toLocaleTimeString('en-GB') : '—'}`,
        `Next fetch:    ${next ? next.toLocaleTimeString('en-GB') : '—'}`,
      ].join('\n');
    }

    // ── Alerts ──
    case 'selected': {
      const k = _ctx.selectedKey;
      if (!k) return '(no alert selected — click a row first)';
      const iss = _ctx.issues.find(i =>
        i.atom_issue_id === k.atomIssueId && i.playlist_id === k.playlistId
      );
      if (!iss) return `Issue not found: ${k.atomIssueId}`;
      return [
        `Feed:     ${iss.feed_code}`,
        `Region:   ${iss.region || '—'}`,
        `Type:     ${iss.issue_type}`,
        `State:    ${iss.state || 'penalty'}`,
        `Playlist: ${iss.playlist_id}`,
        `Date:     ${iss.playlist_date}`,
        `Asset:    ${iss.asset_id || '—'}`,
        `Occs:     ${iss.occ_count || 0}`,
        `Ticket:   ${iss.ticket_id || '—'}`,
        `First:    ${iss.first_occurrence || '—'}`,
        `Last:     ${iss.last_occurrence || '—'}`,
      ].join('\n');
    }

    case 'alerts': {
      const counts = {};
      for (const i of _ctx.issues) {
        const s = i.state || 'penalty';
        counts[s] = (counts[s] || 0) + 1;
      }
      return [
        `Total loaded: ${_ctx.issues.length}`,
        ...Object.entries(counts).map(([s, n]) => `  ${s.padEnd(14)} ${n}`),
      ].join('\n');
    }

    case 'alert': {
      // No arg — list all known feed codes
      if (!arg) {
        const feeds = [...new Set(_ctx.issues.map(i => i.feed_code).filter(Boolean))].sort();
        if (!feeds.length) return `No issues loaded yet. Try running "alerts" first — context has ${_ctx.issues.length} items.`;
        return `Known feeds (${feeds.length}):\n` + feeds.map(f => `  ${f}`).join('\n');
      }
      if (_ctx.issues.length === 0) return `Context is empty — issues not loaded yet. Open the dashboard and wait for data to load, then try again.`;
      const matches = _ctx.issues.filter(i =>
        i.feed_code?.toLowerCase().includes(arg.toLowerCase())
      );
      if (!matches.length) {
        const feeds = [...new Set(_ctx.issues.map(i => i.feed_code).filter(Boolean))].sort();
        return `No alerts found for: "${arg}"\n\nAvailable feeds:\n` + feeds.map(f => `  ${f}`).join('\n');
      }
      return matches.slice(0, 5).map(iss =>
        [
          `─ ${iss.feed_code} / ${iss.issue_type}`,
          `  State:    ${iss.state || 'penalty'}`,
          `  Playlist: ${iss.playlist_id}  (${iss.playlist_date})`,
          `  Asset:    ${iss.asset_id || '—'}`,
          `  Occs:     ${iss.occ_count || 0}`,
        ].join('\n')
      ).join('\n\n') + (matches.length > 5 ? `\n\n...and ${matches.length - 5} more` : '');
    }

    case 'filters': {
      return fmtShort(_ctx.filters);
    }

    case 'states': {
      const groups = { penalty: [], ack: [], ticketed: [], other: [] };
      for (const i of _ctx.issues) {
        const s = i.state || 'penalty';
        const g = groups[s] || groups.other;
        g.push(`${i.feed_code} — ${i.issue_type}`);
      }
      const lines = [];
      for (const [state, items] of Object.entries(groups)) {
        if (items.length === 0) continue;
        lines.push(`[${state.toUpperCase()}] (${items.length})`);
        items.slice(0, 5).forEach(x => lines.push(`  ${x}`));
        if (items.length > 5) lines.push(`  ...+${items.length - 5} more`);
      }
      return lines.join('\n') || '(no alerts loaded)';
    }

    // ── Polling ──
    case 'poll': {
      const last = _ctx.lastFetch ? new Date(_ctx.lastFetch) : null;
      const next = last ? new Date(last.getTime() + _ctx.pollInterval * 1000) : null;
      const recent = _bus.traffic.filter(t => t.url?.includes('/api/issues')).slice(0, 3);
      return [
        `Interval:   ${_ctx.pollInterval}s`,
        `Last:       ${last ? last.toLocaleTimeString('en-GB') : '—'}`,
        `Next:       ${next ? next.toLocaleTimeString('en-GB') : '—'}`,
        ``,
        `Recent issue fetches:`,
        ...recent.map(t => `  ${t.ts} ${t.method} ${t.url} → ${t.status} (${t.ms}ms)`),
      ].join('\n');
    }

    case 'traffic': {
      if (arg === 'clear') { _bus.traffic.length = 0; return 'Traffic log cleared.'; }
      const logs = _bus.traffic.slice(0, 20);
      if (!logs.length) return '(no traffic logged yet)';
      return logs.map(t =>
        `${t.ts}  ${(t.method||'GET').padEnd(6)} ${(t.status||'—').toString().padEnd(4)} ${t.url}${t.ms ? `  (${t.ms}ms)` : ''}`
      ).join('\n');
    }

    case 'lastfetch': {
      const t = _bus.traffic[0];
      if (!t) return '(no fetches logged yet)';
      return [
        `URL:    ${t.url}`,
        `Method: ${t.method || 'GET'}`,
        `Status: ${t.status || '—'}`,
        `Time:   ${t.ts}`,
        `Ms:     ${t.ms || '—'}`,
      ].join('\n');
    }

    // ── Freshdesk ──
    case 'fd': {
      if (arg === 'payload') {
        const e = _bus.fd.find(e => e.type === 'payload');
        return e ? fmtShort(e.data) : '(no FD payload logged)';
      }
      if (arg === 'response') {
        const e = _bus.fd.find(e => e.type === 'response');
        return e ? fmtShort(e.data) : '(no FD response logged)';
      }
      if (arg === 'errors') {
        const errs = _bus.fd.filter(e => e.type === 'error');
        return errs.length ? errs.map(e => `${e.ts}  ${JSON.stringify(e.data)}`).join('\n') : '(no FD errors)';
      }
      if (arg === 'clear') { _bus.fd.length = 0; return 'FD log cleared.'; }
      if (arg === 'last') {
        const e = _bus.fd[0];
        return e ? `${e.ts}  [${e.type}]  ${JSON.stringify(e.data)}` : '(no FD logs)';
      }
      // plain fd — show last 10
      const logs = _bus.fd.slice(0, 10);
      if (!logs.length) return '(no Freshdesk activity logged yet — create a ticket to see logs here)';
      return logs.map(e => `${e.ts}  [${e.type.padEnd(8)}]  ${JSON.stringify(e.data).slice(0, 80)}`).join('\n');
    }

    // ── Debug ──
    case 'errors': {
      const errs = _bus.errors.slice(0, 20);
      if (!errs.length) return '(no API errors logged)';
      return errs.map(e => `${e.ts}  ${e.message}${e.url ? `  (${e.url})` : ''}`).join('\n');
    }

    case 'state': {
      const logs = _bus.stateTransitions.slice(0, 20);
      if (!logs.length) return '(no state transitions logged yet — click Ack on a penalty alert)';
      return logs.map(e => `${e.ts}  ${e.feed || '?'} : ${e.from} → ${e.to}`).join('\n');
    }

    case 'perf': {
      const logs = _bus.perf.slice(0, 20);
      if (!logs.length) return '(no perf timings logged)';
      return logs.map(e => `${e.ts}  ${e.label}  ${e.ms}ms`).join('\n');
    }

    case 'json': {
      return fmtShort({
        issues_count: _ctx.issues.length,
        selected:     _ctx.selectedKey,
        filters:      _ctx.filters,
        region:       _ctx.region,
        stats:        _ctx.stats,
        last_fetch:   _ctx.lastFetch,
      });
    }

    // ── Dev ──
    case 'log':
      if (arg === 'off') return '__LOG_OFF__';
      return '__LOG_ON__';

    case 'watch':
      if (arg === 'off') return '__WATCH_OFF__';
      return '__WATCH_ON__';

    case 'version':
      return `Sentinel SRE Console v1.0\nBuild: ${new Date().toISOString().split('T')[0]}`;

    case '':
      return '';

    default:
      return `Unknown command: ${cmd}\nType "help" for available commands.`;
  }
}

const HELP_TEXT = `Available commands:
─────────────────────────────
Core:
  help              Show this list
  clear             Clear output
  close             Close terminal
  status            Dashboard status
  time              Poll timing

Alerts:
  selected          Currently selected alert
  alerts            Count by state
  alert <feed>      Find alert by feed code
  filters           Active filters
  states            Alerts grouped by state

Polling:
  poll              Poll info + recent fetches
  traffic           API traffic log
  traffic clear     Clear traffic log
  lastfetch         Last API call details

Freshdesk:
  fd                Recent FD activity
  fd payload        Last payload sent
  fd response       Last response received
  fd errors         Failed attempts only
  fd clear          Clear FD log
  fd last           Most recent entry

Debug:
  errors            API error log
  state             State transition history
  perf              Performance timings
  json              Full dashboard state dump
  version           Console version

Dev:
  log               Enable live log stream
  log off           Stop live logs
  watch             Auto-refresh output
  watch off         Stop watch
  close             Close terminal`;

// ── Line reducer ──────────────────────────────────────────────────────────────
function linesReducer(state, action) {
  switch (action.type) {
    case 'PUSH':    return [...state, action.line];
    case 'CLEAR':   return [{ type: 'system', text: 'Terminal cleared.' }];
    case 'RESET':   return action.lines || [];
    default:        return state;
  }
}

// ── Main terminal component ───────────────────────────────────────────────────
export default function SRETerminal({ issues, selectedKey, filters, stats, region }) {
  const [open,     setOpen]     = useState(false);
  const [input,    setInput]    = useState('');
  const [history,  setHistory]  = useState([]);
  const [histIdx,  setHistIdx]  = useState(-1);
  const [lines,    dispatch]    = useReducer(linesReducer, [
    { type: 'system', text: 'Sentinel SRE Console — type "help" for commands' },
    { type: 'system', text: '─────────────────────────────────────────────────' },
  ]);
  const [liveLog,  setLiveLog]  = useState(false);
  const [watching, setWatching] = useState(false);
  const [pos,      setPos]      = useState({ x: null, y: null });
  const [dragging, setDragging] = useState(false);

  const outputRef  = useRef(null);
  const inputRef   = useRef(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const watchTimer = useRef(null);
  const keyBuf     = useRef('');
  const keyTimer   = useRef(null);

  // ── Sync context ────────────────────────────────────────────────────────────
  useEffect(() => {
    setSREContext({ issues, selectedKey, filters, stats, region });
  }, [issues, selectedKey, filters, stats, region]);

  // ── "letmein" keypress detection ────────────────────────────────────────────
  useEffect(() => {
    const SECRET = 'letmein';
    const onKey = (e) => {
      // Ignore when typing in an input/textarea
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Ctrl+` toggle
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setOpen(v => !v);
        return;
      }
      // ESC close
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }

      // Buffer single chars for "letmein"
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        keyBuf.current += e.key.toLowerCase();
        if (keyBuf.current.length > SECRET.length) {
          keyBuf.current = keyBuf.current.slice(-SECRET.length);
        }
        clearTimeout(keyTimer.current);
        keyTimer.current = setTimeout(() => { keyBuf.current = ''; }, 1500);
        if (keyBuf.current === SECRET) {
          keyBuf.current = '';
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(keyTimer.current); };
  }, [open]);

  // ── Auto-scroll output ───────────────────────────────────────────────────────
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  // ── Focus input when opened ──────────────────────────────────────────────────
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  // ── Watch mode ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (watching) {
      watchTimer.current = setInterval(() => {
        const snapshot = `[WATCH ${now()}] issues:${_ctx.issues.length} penalty:${_ctx.stats?.state_penalty ?? '?'} ack:${_ctx.stats?.state_ack ?? '?'} ticketed:${_ctx.stats?.state_ticketed ?? '?'}`;
        dispatch({ type: 'PUSH', line: { type: 'watch', text: snapshot } });
      }, 3000);
    } else {
      clearInterval(watchTimer.current);
    }
    return () => clearInterval(watchTimer.current);
  }, [watching]);

  // ── Live log stream ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!liveLog) return;
    let lastTrafficLen = _bus.traffic.length;
    let lastFDLen      = _bus.fd.length;
    let lastErrLen     = _bus.errors.length;
    const t = setInterval(() => {
      if (_bus.traffic.length > lastTrafficLen) {
        const newItems = _bus.traffic.slice(0, _bus.traffic.length - lastTrafficLen);
        newItems.reverse().forEach(e =>
          dispatch({ type: 'PUSH', line: { type: 'live', text: `[TRAFFIC] ${e.ts} ${e.method} ${e.url} → ${e.status}` } })
        );
        lastTrafficLen = _bus.traffic.length;
      }
      if (_bus.fd.length > lastFDLen) {
        const newItems = _bus.fd.slice(0, _bus.fd.length - lastFDLen);
        newItems.reverse().forEach(e =>
          dispatch({ type: 'PUSH', line: { type: 'live', text: `[FD] ${e.ts} [${e.type}] ${JSON.stringify(e.data).slice(0, 60)}` } })
        );
        lastFDLen = _bus.fd.length;
      }
      if (_bus.errors.length > lastErrLen) {
        const newItems = _bus.errors.slice(0, _bus.errors.length - lastErrLen);
        newItems.reverse().forEach(e =>
          dispatch({ type: 'PUSH', line: { type: 'error', text: `[ERROR] ${e.ts} ${e.message}` } })
        );
        lastErrLen = _bus.errors.length;
      }
    }, 500);
    return () => clearInterval(t);
  }, [liveLog]);

  // ── Submit command ───────────────────────────────────────────────────────────
  const submit = useCallback(() => {
    const raw = input.trim();
    dispatch({ type: 'PUSH', line: { type: 'input', text: `> ${raw}` } });

    // History
    if (raw) {
      setHistory(h => [raw, ...h.filter(x => x !== raw)].slice(0, 50));
      setHistIdx(-1);
    }

    const result = runCommand(raw);

    if (result === '__CLEAR__') {
      dispatch({ type: 'CLEAR' });
    } else if (result === '__CLOSE__') {
      setOpen(false);
    } else if (result === '__LOG_ON__') {
      setLiveLog(true);
      dispatch({ type: 'PUSH', line: { type: 'system', text: 'Live log streaming ON. Type "log off" to stop.' } });
    } else if (result === '__LOG_OFF__') {
      setLiveLog(false);
      dispatch({ type: 'PUSH', line: { type: 'system', text: 'Live log streaming OFF.' } });
    } else if (result === '__WATCH_ON__') {
      setWatching(true);
      dispatch({ type: 'PUSH', line: { type: 'system', text: 'Watch mode ON (3s interval). Type "watch off" to stop.' } });
    } else if (result === '__WATCH_OFF__') {
      setWatching(false);
      dispatch({ type: 'PUSH', line: { type: 'system', text: 'Watch mode OFF.' } });
    } else if (result !== '') {
      result.split('\n').forEach(line =>
        dispatch({ type: 'PUSH', line: { type: 'output', text: line } })
      );
    }

    setInput('');
  }, [input]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      if (history[idx] !== undefined) setInput(history[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setInput(idx === -1 ? '' : history[idx] || '');
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Simple autocomplete
      const cmds = ['help','clear','close','status','time','selected','alerts','alert','filters','states','poll','traffic','lastfetch','fd','errors','state','perf','json','log','watch','version'];
      const match = cmds.find(c => c.startsWith(input.toLowerCase()));
      if (match) setInput(match);
    }
  }, [submit, histIdx, history, input]);

  // ── Drag ────────────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    if (e.target.closest('.sre-input-row')) return;
    setDragging(true);
    const rect = e.currentTarget.closest('.sre-terminal').getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      setPos({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  if (!open) return null;

  // Position: default bottom-right, or dragged position
  const style = pos.x !== null
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {};

  return (
    <div className={`sre-terminal ${dragging ? 'dragging' : ''}`} style={style}>
      {/* Title bar — drag handle */}
      <div className="sre-titlebar" onMouseDown={onMouseDown}>
        <span className="sre-title">
          <span className="sre-title-dot" />
          Sentinel SRE Console
          {liveLog  && <span className="sre-badge live">LIVE</span>}
          {watching && <span className="sre-badge watch">WATCH</span>}
        </span>
        <div className="sre-title-right">
          <span className="sre-hint">letmein / Ctrl+` / ESC</span>
          <button className="sre-close-btn" onClick={() => setOpen(false)}>✕</button>
        </div>
      </div>

      {/* Output */}
      <div className="sre-output" ref={outputRef}>
        {lines.map((line, i) => (
          <div key={i} className={`sre-line sre-${line.type}`}>
            {line.text}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="sre-input-row">
        <span className="sre-prompt">›</span>
        <input
          ref={inputRef}
          className="sre-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="type a command…"
        />
      </div>
    </div>
  );
}
