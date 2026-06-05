import React, { useState, useEffect, useCallback } from 'react';
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';
import './App.css';

const formatTime = (dateStr) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
};

function FingerprintIcon({ color = '#0f766e', size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 2C7.58 2 4 5.58 4 10" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M20 10c0-4.42-3.58-8-8-8" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7 10c0-2.76 2.24-5 5-5s5 2.24 5 5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 10a2 2 0 0 1 4 0" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 10v5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8.5 15.5A5.5 5.5 0 0 0 17 12" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 13c0 4 3 7 7 7s7-3 7-7" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [attendance, setAttendance] = useState([]);
  const [employeeName, setEmployeeName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setAttendance([]);
    setEmployeeName('');
    setEmployeeId('');
    setError('');
  }, []);

  const fetchAttendance = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `http://localhost:8000/api/attendance?month=${selectedMonth}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) throw new Error('Failed to fetch attendance');
      const data = await res.json();
      setAttendance(Array.isArray(data) ? data : []);
      if (data.length > 0) {
        setEmployeeName(data[0].Name);
        setEmployeeId(data[0].UserID);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedMonth, handleLogout]);

  useEffect(() => {
    if (token) fetchAttendance();
  }, [token, selectedMonth, fetchAttendance]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('http://localhost:8000/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Login failed');
      }
      const data = await res.json();
      localStorage.setItem('token', data.access_token);
      setToken(data.access_token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const attendanceByDate = {};
  attendance.forEach(r => { attendanceByDate[r.AttendanceDate] = r; });

  const getStatus = (minutes) => {
    if (minutes < 270) return { label: 'A', full: 'Absent', cls: 'absent' };
    if (minutes < 540) return { label: 'HD', full: 'Half Day', cls: 'halfday' };
    return { label: 'P', full: 'Present', cls: 'present' };
  };

  const computeSummary = () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    let present = 0, halfDay = 0, absent = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const rec = attendanceByDate[dateStr];
      if (!rec) { absent++; continue; }
      const s = getStatus(rec.WorkingMinutes);
      if (s.label === 'P') present++;
      else if (s.label === 'HD') halfDay++;
      else absent++;
    }
    return { present, halfDay, absent };
  };

  const summary = computeSummary();

  const tileContent = ({ date, view }) => {
    if (view !== 'month') return null;
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const rec = attendanceByDate[dateStr];
    if (!rec) return null;
    const status = getStatus(rec.WorkingMinutes);
    const dateLabel = date.toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    return (
      <div className={`day-tile tile-${status.cls}`}>
        <span className="tile-label">{status.label}</span>
        <div className="day-tooltip">
          <div className="tt-date">{dateLabel}</div>
          <div className="tt-grid">
            <span className="tt-key">Punch In</span>
            <span className="tt-val">{formatTime(rec.FirstPunchIn)}</span>
            <span className="tt-key">Punch Out</span>
            <span className="tt-val">{formatTime(rec.LastPunchOut)}</span>
            <span className="tt-key">Login Hrs</span>
            <span className="tt-val">{rec.WorkingHours}</span>
            <span className="tt-key">Status</span>
            <span className={`tt-status tt-s-${status.cls}`}>{status.full} ({status.label})</span>
          </div>
          <div className="tt-arrow" />
        </div>
      </div>
    );
  };

  // ── Login ──────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="login-bg">
        <div className="login-card">
          <div className="login-brand">
            <FingerprintIcon size={52} />
            <h1>Biometric Attendance</h1>
            <p>Employee Self Service Portal</p>
          </div>
          <form onSubmit={handleLogin} className="login-form">
            <div className="field">
              <label>User ID</label>
              <input
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value.toUpperCase())}
                placeholder="e.g. MAS60358"
                required
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="UserID@123"
                required
              />
            </div>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
          <p className="login-hint">Default password: YourID@123</p>
        </div>
      </div>
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────────
  const [yr, mo] = selectedMonth.split('-').map(Number);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="header-left">
          <div className="header-brand">
            <FingerprintIcon color="rgba(255,255,255,0.95)" size={28} />
            <span className="brand-text">Biometric Attendance</span>
          </div>
          {employeeName && (
            <div className="header-emp">
              <span className="emp-name">{employeeName}</span>
              {employeeId && <span className="emp-chip">{employeeId}</span>}
            </div>
          )}
        </div>
        <div className="header-right">
          <label className="month-wrap">
            <span className="month-lbl">Month</span>
            <input
              type="month"
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              className="month-input"
            />
          </label>
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-icon si-present">✓</div>
          <div className="stat-num sn-present">{summary.present}</div>
          <div className="stat-lbl">Present</div>
          <div className="stat-bar sb-present" />
        </div>
        <div className="stat-card">
          <div className="stat-icon si-halfday">½</div>
          <div className="stat-num sn-halfday">{summary.halfDay}</div>
          <div className="stat-lbl">Half Day</div>
          <div className="stat-bar sb-halfday" />
        </div>
        <div className="stat-card">
          <div className="stat-icon si-absent">✗</div>
          <div className="stat-num sn-absent">{summary.absent}</div>
          <div className="stat-lbl">Absent / Short</div>
          <div className="stat-bar sb-absent" />
        </div>
      </div>

      {loading && <div className="loader"><span className="loader-dot" />Loading attendance…</div>}
      {error && <div className="dash-error">{error}</div>}

      {!loading && !error && (
        <div className="cal-card">
          <Calendar
            tileContent={tileContent}
            value={new Date(yr, mo - 1, 1)}
            className="att-cal"
          />
          <div className="cal-legend">
            <span className="legend-item"><i className="ldot ld-present" />Present (≥ 9 hrs)</span>
            <span className="legend-item"><i className="ldot ld-halfday" />Half Day (4.5 – 9 hrs)</span>
            <span className="legend-item"><i className="ldot ld-absent" />Absent (&lt; 4.5 hrs)</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
