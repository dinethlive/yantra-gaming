import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { useAuthStore } from '../store/authStore';

interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  engagedAt: string | null;
  engagedBy: string | null;
}

export function Sidebar() {
  const { user, logout } = useAuthStore();
  const [kill, setKill] = useState<KillSwitchState | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const s = await apiRequest<KillSwitchState>('/v1/platform/kill-switch');
      setKill(s);
    } catch {
      /* ignore — sidebar must not crash if the endpoint 401s */
    }
  }

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, []);

  async function engage() {
    const reason = window.prompt(
      'GLOBAL KILL-SWITCH — blocks EVERY new session launch across ALL operators.\nIn-flight rounds continue settling (GLI-19 §3).\n\nEnter reason (shown in audit log):',
    );
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      const s = await apiRequest<KillSwitchState>(
        '/v1/platform/kill-switch/engage',
        { method: 'POST', body: { reason: reason.trim() } },
      );
      setKill(s);
    } finally {
      setBusy(false);
    }
  }

  async function disengage() {
    if (!window.confirm('Disengage global kill-switch? Session launches resume immediately.')) return;
    setBusy(true);
    try {
      const s = await apiRequest<KillSwitchState>(
        '/v1/platform/kill-switch/disengage',
        { method: 'POST' },
      );
      setKill(s);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">KP</span>
        <div>
          <div className="sidebar__title">Yantra</div>
          <div className="sidebar__subtitle">Platform admin</div>
        </div>
      </div>

      {kill?.engaged ? (
        <div className="banner banner--danger" style={{ marginBottom: 12 }}>
          <strong>GLOBAL HALT ENGAGED</strong>
          <div>{kill.reason ?? 'no reason given'}</div>
          {kill.engagedBy ? <div>by {kill.engagedBy}</div> : null}
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={disengage}
          >
            Disengage
          </button>
        </div>
      ) : null}

      <nav className="sidebar__nav">
        <NavLink to="/" end className="sidebar__link">
          Overview
        </NavLink>
        <div className="sidebar__group">Compliance</div>
        <NavLink to="/settlement" className="sidebar__link">
          Settlement &amp; integrity
        </NavLink>
        <NavLink to="/rtp" className="sidebar__link">
          RTP drift
        </NavLink>
        <NavLink to="/sla" className="sidebar__link">
          Wallet SLA
        </NavLink>
        <NavLink to="/certificates" className="sidebar__link">
          Certificates
        </NavLink>
        <NavLink to="/par-sheet" className="sidebar__link">
          PAR sheet
        </NavLink>
        <div className="sidebar__group">Investigations</div>
        <NavLink to="/rounds" className="sidebar__link">
          Round finder
        </NavLink>
        <NavLink to="/pf" className="sidebar__link">
          Proof viewer
        </NavLink>
        <NavLink to="/audit" className="sidebar__link">
          Audit trail
        </NavLink>
        <div className="sidebar__group">Tenants</div>
        <NavLink to="/operators" className="sidebar__link">
          Operators
        </NavLink>
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__user">
          <div className="sidebar__user-name">{user?.displayName ?? '—'}</div>
          <div className="sidebar__user-role">{user?.role ?? '—'}</div>
        </div>
        <NavLink to="/settings" className="btn btn--ghost btn--small">
          Account &amp; MFA
        </NavLink>
        {!kill?.engaged ? (
          <button
            type="button"
            className="btn btn--small btn--danger-ghost"
            disabled={busy}
            onClick={engage}
            title="Block all new session launches across all operators"
          >
            Emergency halt
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={logout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
