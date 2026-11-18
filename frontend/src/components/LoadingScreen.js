import React, { useEffect, useState } from 'react';
import './LoadingScreen.css';

const MESSAGES = [
  'Sentinel is scanning alerts…',
  'Fetching playlist timeline…',
  'Syncing occurrences…',
  'Building alert groups…',
  'Almost ready…',
];

export default function LoadingScreen({ appName = 'SENTINEL', subtitle = 'TOC Alert Monitoring & Ticket Automation' }) {
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setMsgIdx(i => (i + 1) % MESSAGES.length), 1100);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="loading-screen">
      <div className="ls-content">
        <div className="ls-icon">
          <PulseIcon />
        </div>
        <div className="ls-brand">
          <span className="ls-title">{appName}</span>
          <span className="ls-subtitle">{subtitle}</span>
        </div>
        <div className="ls-bar-track">
          <div className="ls-bar-fill" />
        </div>
        <div className="ls-message">{MESSAGES[msgIdx]}</div>
      </div>
    </div>
  );
}

function PulseIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer pulse ring */}
      <circle cx="24" cy="24" r="22" stroke="var(--accent)" strokeWidth="1" strokeDasharray="4 3" opacity="0.4" className="ls-ring-outer" />
      {/* Middle ring */}
      <circle cx="24" cy="24" r="15" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6" className="ls-ring-mid" />
      {/* Core */}
      <circle cx="24" cy="24" r="7" fill="var(--accent-dim)" stroke="var(--accent)" strokeWidth="2" />
      {/* Center dot */}
      <circle cx="24" cy="24" r="3" fill="var(--accent)" className="ls-core-dot" />
    </svg>
  );
}
