import React, { useCallback, useEffect, useRef, useState } from 'react';
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';
import './App.css';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL
  || `${window.location.protocol}//${window.location.hostname}:8000`;
const PROFILE_STORAGE_KEY = 'attendanceProfileV2';

const toDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

const formatTime = (dateStr) => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit'
  });
};

const formatDateTime = (dateStr) => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
};

const readStoredProfile = () => {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
};

const readTokenProfile = (token) => {
  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=');
    const payload = JSON.parse(atob(paddedPayload));
    return {
      emp_code: payload.sub || '',
      role: payload.role || ''
    };
  } catch {
    return {};
  }
};

const saveProfile = (profile) => {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
};

const getStatus = (minutes) => {
  if (minutes < 270) return { label: 'A', full: 'Absent', cls: 'absent' };
  if (minutes < 540) return { label: 'HD', full: 'Half Day', cls: 'halfday' };
  return { label: 'P', full: 'Present', cls: 'present' };
};

export const buildSummary = (year, month, attendanceByDate, holidayByDate, today = new Date()) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  const summary = { present: 0, halfDay: 0, absent: 0 };

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month - 1, day);
    const dateKey = toDateKey(date);
    const record = attendanceByDate[dateKey];

    if (date > today || holidayByDate[dateKey]) continue;
    if (date.getDay() === 0 && (!record || getStatus(record.WorkingMinutes).label === 'A')) continue;

    if (!record) {
      summary.absent += 1;
      continue;
    }

    const status = getStatus(record.WorkingMinutes);
    if (status.label === 'P') summary.present += 1;
    else if (status.label === 'HD') summary.halfDay += 1;
    else summary.absent += 1;
  }

  return summary;
};

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const initialProfile = readStoredProfile();
  const tokenProfile = readTokenProfile(token);
  const [empCode, setEmpCode] = useState('');
  const [password, setPassword] = useState('');
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [attendance, setAttendance] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [employeeName, setEmployeeName] = useState(initialProfile.name || '');
  const [employeeCode, setEmployeeCode] = useState(initialProfile.emp_code || tokenProfile.emp_code || '');
  const [designation, setDesignation] = useState('Not specified');
  const [role, setRole] = useState(initialProfile.role || tokenProfile.role || '');
  const [profileOpen, setProfileOpen] = useState(false);
  const [showHolidayPanel, setShowHolidayPanel] = useState(false);
  const [showEmployeePanel, setShowEmployeePanel] = useState(false);
  const [showSupportPanel, setShowSupportPanel] = useState(false);
  const [showManagerQueries, setShowManagerQueries] = useState(false);
  const [isManager, setIsManager] = useState(
    Boolean(initialProfile.is_manager || tokenProfile.role?.toLowerCase() === 'manager')
  );
  const [supportQueries, setSupportQueries] = useState([]);
  const [managerQueries, setManagerQueries] = useState([]);
  const [supportText, setSupportText] = useState('');
  const [supportImage, setSupportImage] = useState(null);
  const [supportFileKey, setSupportFileKey] = useState(0);
  const [supportMessage, setSupportMessage] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayReason, setNewHolidayReason] = useState('');
  const [editingHolidayId, setEditingHolidayId] = useState(null);
  const [newEmployee, setNewEmployee] = useState({
    emp_name: '',
    designation: '',
    role: 'Employee',
    emp_code: ''
  });
  const [employeeFormMessage, setEmployeeFormMessage] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState(null);
  const [searchEmpCode, setSearchEmpCode] = useState('');
  const [searchEmpName, setSearchEmpName] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchMessage, setSearchMessage] = useState('');
  const profileButtonRef = useRef(null);
  const profilePopupRef = useRef(null);

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  useEffect(() => {
    if (!profileOpen) return undefined;

    const closeProfileOnOutsideClick = (event) => {
      if (profilePopupRef.current?.contains(event.target)) return;
      if (profileButtonRef.current?.contains(event.target)) return;
      setProfileOpen(false);
    };

    document.addEventListener('mousedown', closeProfileOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeProfileOnOutsideClick);
  }, [profileOpen]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    setToken(null);
    setAttendance([]);
    setHolidays([]);
    setEmployees([]);
    setEmployeeName('');
    setEmployeeCode('');
    setDesignation('Not specified');
    setRole('');
    setProfileOpen(false);
    setShowHolidayPanel(false);
    setShowEmployeePanel(false);
    setShowSupportPanel(false);
    setShowManagerQueries(false);
    setIsManager(false);
    setSupportQueries([]);
    setManagerQueries([]);
    setSupportText('');
    setSupportImage(null);
    setSupportMessage('');
    setEmployeeFormMessage('');
    setEditingEmployeeId(null);
    setEditingHolidayId(null);
    setSearchEmpCode('');
    setSearchEmpName('');
    setSearchVersion(0);
    setSearchMessage('');
    setError('');
  }, []);

  const roleRef = useRef(role);
  useEffect(() => { roleRef.current = role; }, [role]);
  const searchEmpCodeRef = useRef(searchEmpCode);
  useEffect(() => { searchEmpCodeRef.current = searchEmpCode; }, [searchEmpCode]);
  const searchEmpNameRef = useRef(searchEmpName);
  useEffect(() => { searchEmpNameRef.current = searchEmpName; }, [searchEmpName]);

  const fetchAttendance = useCallback(async () => {
    setLoading(true);
    setError('');
    setSearchMessage('');
    try {
      const isSuperAdmin = roleRef.current.toLowerCase() === 'superadmin';
      let url = `${API_BASE_URL}/api/attendance?month=${selectedMonth}`;
      if (isSuperAdmin && searchEmpCodeRef.current.trim()) {
        url += `&search_emp_code=${encodeURIComponent(searchEmpCodeRef.current.trim())}`;
      } else if (isSuperAdmin && searchEmpNameRef.current.trim()) {
        url += `&search_emp_name=${encodeURIComponent(searchEmpNameRef.current.trim())}`;
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      if (!response.ok) throw new Error('Failed to load attendance');
      const data = await response.json();
      const records = Array.isArray(data) ? data : [];
      setAttendance(records);

      if (isSuperAdmin) {
        if (searchEmpCodeRef.current.trim() && records.length === 0) {
          setSearchMessage(`No attendance found for ${searchEmpCodeRef.current.trim()}`);
        } else if (searchEmpCodeRef.current.trim() && records.length > 0) {
          setSearchMessage(`Showing attendance for ${records[0].Name || searchEmpCodeRef.current.trim()}`);
        } else if (searchEmpNameRef.current.trim()) {
          const uniqueIds = [...new Set(records.map((r) => r.UserID))];
          if (uniqueIds.length === 0) {
            setSearchMessage(`No attendance found for name matching "${searchEmpNameRef.current.trim()}"`);
          } else {
            setSearchMessage(`Found ${uniqueIds.length} employee(s) matching "${searchEmpNameRef.current.trim()}"`);
          }
        }
      }

      if (records.length > 0 && !isSuperAdmin) {
        const storedProfile = readStoredProfile();
        const currentTokenProfile = readTokenProfile(token);
        const fallbackProfile = {
          name: storedProfile.name || records[0].Name || '',
          emp_code: storedProfile.emp_code || records[0].UserID || currentTokenProfile.emp_code || '',
          designation: records[0].Designation || 'Not specified',
          role: records[0].Role || storedProfile.role || currentTokenProfile.role || 'Employee'
        };
        setEmployeeName((currentName) => currentName || fallbackProfile.name);
        setEmployeeCode((currentCode) => currentCode || fallbackProfile.emp_code);
        setDesignation(records[0].Designation || fallbackProfile.designation);
        setRole(records[0].Role || fallbackProfile.role);
        saveProfile(fallbackProfile);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [handleLogout, selectedMonth, token, searchVersion]);

  const fetchHolidays = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/holidays?month=${selectedMonth}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setHolidays(Array.isArray(data) ? data : []);
      }
    } catch (requestError) {
      console.error('Holidays fetch error', requestError);
    }
  }, [selectedMonth, token]);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      if (!response.ok) throw new Error('Failed to load profile');
      const data = await response.json();
      setEmployeeName(data.name || 'Employee');
      setEmployeeCode(data.emp_code || '');
      setDesignation(data.designation || 'Not specified');
      setRole(data.role || 'User');
      setIsManager(Boolean(data.is_manager));
      saveProfile(data);
    } catch {}
  }, [handleLogout, token]);

  const fetchEmployees = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/employees`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to load employees');
      const data = await response.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setEmployeeFormMessage(requestError.message);
    }
  }, [token]);

  const fetchSupportQueries = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/support-queries`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      if (!response.ok) throw new Error('Failed to load support queries');
      const data = await response.json();
      setSupportQueries(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setSupportMessage(requestError.message);
    }
  }, [handleLogout, token]);

  const fetchManagerQueries = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/manager/support-queries`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      const data = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(data.detail || 'Failed to load manager queries');
      setManagerQueries(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setSupportMessage(requestError.message);
    }
  }, [handleLogout, token]);

  useEffect(() => {
    if (!token) return;
    fetchAttendance();
    fetchHolidays();
    fetchProfile();
  }, [fetchAttendance, fetchHolidays, fetchProfile, token]);

  useEffect(() => {
    if (!token || !showSupportPanel) return undefined;
    fetchSupportQueries();
    const refreshTimer = window.setInterval(fetchSupportQueries, 15000);
    return () => window.clearInterval(refreshTimer);
  }, [fetchSupportQueries, showSupportPanel, token]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    setAuthMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emp_code: empCode, password })
      });
      if (!response.ok) {
        const responseError = await response.json().catch(() => ({}));
        throw new Error(responseError.detail || 'Login failed');
      }
      const data = await response.json();
      localStorage.setItem('token', data.access_token);
      setToken(data.access_token);
      setEmployeeName(data.name || 'Employee');
      setEmployeeCode(data.emp_code || empCode);
      setDesignation(data.designation || 'Not specified');
      setRole(data.role || 'User');
      setIsManager(String(data.role || '').toLowerCase() === 'manager');
      saveProfile({
        name: data.name || 'Employee',
        emp_code: data.emp_code || empCode,
        designation: data.designation || 'Not specified',
        role: data.role || 'User'
      });
      setEmpCode('');
      setPassword('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    setAuthMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emp_code: empCode, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to update password');
      }

      setForgotPasswordOpen(false);
      setPassword('');
      setAuthMessage(data.message || 'Password updated successfully. You can now sign in.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleForgotPassword = () => {
    setForgotPasswordOpen((open) => !open);
    setPassword('');
    setError('');
    setAuthMessage('');
  };

  const createHoliday = async (event) => {
    event.preventDefault();
    if (!newHolidayDate || !newHolidayReason.trim()) return;

    try {
      const response = await fetch(
        editingHolidayId
          ? `${API_BASE_URL}/api/holidays/${editingHolidayId}`
          : `${API_BASE_URL}/api/holidays`,
        {
        method: editingHolidayId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          holiday_date: newHolidayDate,
          reason: newHolidayReason.trim()
        })
      });
      if (!response.ok) {
        const responseError = await response.json().catch(() => ({}));
        throw new Error(responseError.detail || 'Failed to save holiday');
      }
      setNewHolidayDate('');
      setNewHolidayReason('');
      setEditingHolidayId(null);
      fetchHolidays();
    } catch (requestError) {
      window.alert(requestError.message);
    }
  };

  const editHoliday = (holiday) => {
    setEditingHolidayId(holiday.id);
    setNewHolidayDate(holiday.holiday_date);
    setNewHolidayReason(holiday.reason);
  };

  const cancelHolidayEdit = () => {
    setEditingHolidayId(null);
    setNewHolidayDate('');
    setNewHolidayReason('');
  };

  const deleteHoliday = async (id) => {
    if (!window.confirm('Delete this holiday?')) return;

    const response = await fetch(`${API_BASE_URL}/api/holidays/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok) fetchHolidays();
    else window.alert('Delete failed');
  };

  const saveEmployee = async (event) => {
    event.preventDefault();
    setEmployeeFormMessage('');

    try {
      const response = await fetch(
        editingEmployeeId
          ? `${API_BASE_URL}/api/employees/${editingEmployeeId}`
          : `${API_BASE_URL}/api/employees`,
        {
        method: editingEmployeeId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(newEmployee)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to add employee');

      setEmployeeFormMessage(
        `Employee ${data.emp_code} ${editingEmployeeId ? 'updated' : 'added'} successfully.`
      );
      setNewEmployee({
        emp_name: '',
        designation: '',
        role: 'Employee',
        emp_code: ''
      });
      setEditingEmployeeId(null);
      fetchEmployees();
    } catch (requestError) {
      setEmployeeFormMessage(requestError.message);
    }
  };

  const updateNewEmployee = (field, value) => {
    setNewEmployee((current) => ({ ...current, [field]: value }));
  };

  const editEmployee = (employee) => {
    setEditingEmployeeId(employee.id);
    setNewEmployee({
      emp_name: employee.emp_name,
      designation: employee.designation,
      role: employee.role,
      emp_code: employee.emp_code
    });
    setEmployeeFormMessage('');
  };

  const cancelEmployeeEdit = () => {
    setEditingEmployeeId(null);
    setNewEmployee({
      emp_name: '',
      designation: '',
      role: 'Employee',
      emp_code: ''
    });
    setEmployeeFormMessage('');
  };

  const sendSupportQuery = async (event) => {
    event.preventDefault();
    if (!supportText.trim()) return;

    setSupportLoading(true);
    setSupportMessage('');
    const formData = new FormData();
    formData.append('query_text', supportText.trim());
    if (supportImage) formData.append('image', supportImage);

    try {
      const response = await fetch(`${API_BASE_URL}/api/support-queries`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to send query');
      setSupportText('');
      setSupportImage(null);
      setSupportFileKey((key) => key + 1);
      setSupportMessage(`Query sent to ${data.manager_name}.`);
      await fetchSupportQueries();
    } catch (requestError) {
      setSupportMessage(requestError.message);
    } finally {
      setSupportLoading(false);
    }
  };

  const solveSupportQuery = async (queryId) => {
    setSupportMessage('');
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/manager/support-queries/${queryId}/solve`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to solve query');
      setManagerQueries((queries) => (
        queries.map((query) => (query.id === queryId ? data : query))
      ));
      setSupportMessage('Query marked as solved.');
    } catch (requestError) {
      setSupportMessage(requestError.message);
    }
  };

  const openSupportImage = async (queryId) => {
    const imageWindow = window.open('', '_blank');
    try {
      const response = await fetch(`${API_BASE_URL}/api/support-queries/${queryId}/image`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Unable to open attachment');
      const imageBlob = await response.blob();
      const imageUrl = URL.createObjectURL(imageBlob);
      if (imageWindow) {
        imageWindow.location = imageUrl;
      } else {
        window.open(imageUrl, '_blank', 'noopener,noreferrer');
      }
      window.setTimeout(() => URL.revokeObjectURL(imageUrl), 60000);
    } catch (requestError) {
      if (imageWindow) imageWindow.close();
      setSupportMessage(requestError.message);
    }
  };

  const attendanceByDate = {};
  attendance.forEach((record) => {
    attendanceByDate[record.AttendanceDate] = record;
  });
  const holidayByDate = {};
  holidays.forEach((holiday) => {
    holidayByDate[holiday.holiday_date] = holiday;
  });

  const tileContent = ({ date, view }) => {
    if (view !== 'month') return null;

    const dateKey = toDateKey(date);
    const previousDate = new Date(date);
    previousDate.setDate(date.getDate() - 1);
    const previousDateLabel = previousDate.toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
    const holiday = holidayByDate[dateKey];
    const record = attendanceByDate[dateKey];
    const status = record ? getStatus(record.WorkingMinutes) : null;
    const isSunday = date.getDay() === 0;
    const isFuture = date > today;
    const isSundayOff = isSunday && (!record || status.label === 'A');
    let tileClass = 'tile-empty';
    let tileLabel = '-';
    if (holiday) {
      tileClass = 'tile-holiday';
      tileLabel = 'Holiday';
    } else if (isSundayOff) {
      tileClass = 'tile-sunday';
      tileLabel = 'Sunday';
    } else if (record) {
      tileClass = `tile-${status.cls}`;
      tileLabel = status.label;
    } else if (!isFuture) {
      tileClass = 'tile-absent';
      tileLabel = 'A';
    }

    return (
      <div className="day-tile">
        <span className="tile-date">{date.getDate()}</span>
        <span className={`tile-status ${tileClass}`}>
          <span className="tile-label">{tileLabel}</span>
        </span>
        <div className="day-tooltip">
          <div className="tt-date">
            {date.toLocaleDateString('en-IN', {
              weekday: 'long',
              day: 'numeric',
              month: 'long'
            })}
          </div>
          <div className="tt-prev">Previous Day: {previousDateLabel}</div>
          {holiday && <div className="tt-holiday">Holiday: {holiday.reason}</div>}
          {record ? (
            <div className="tt-grid">
              <span className="tt-key">Punch In</span>
              <span className="tt-val">{formatTime(record.FirstPunchIn)}</span>
              <span className="tt-key">Punch Out</span>
              <span className="tt-val">{formatTime(record.LastPunchOut)}</span>
              <span className="tt-key">Attempts / Punches</span>
              <span className="tt-val">{record.TotalPunches}</span>
              <span className="tt-key">Login Hours</span>
              <span className="tt-val">{record.WorkingHours}</span>
              <span className="tt-key">Status</span>
              <span className={`tt-status ${isSundayOff && !holiday ? 'tt-s-sunday' : `tt-s-${status.cls}`}`}>
                {isSundayOff && !holiday ? 'Weekly Off' : status.full}
              </span>
            </div>
          ) : holiday ? (
            <div className="tt-empty">No attendance punches on this holiday</div>
          ) : isSunday ? (
            <div className="tt-empty">Weekly off - not counted as absent</div>
          ) : isFuture ? (
            <div className="tt-empty">Future date</div>
          ) : (
            <div className="tt-empty">No attendance record - Absent</div>
          )}
          <div className="tt-arrow" />
        </div>
      </div>
    );
  };

  if (!token) {
    return (
      <div className="login-bg">
        <div className="login-card">
          <div className="login-brand">
            <img src="/maslogo.png" alt="MAS Logo" className="logo-img" />
            <h1>Biometric Attendance</h1>
            <p>
              {forgotPasswordOpen
                ? 'Create a new password for your employee account'
                : 'Employee Self Service Portal'}
            </p>
          </div>
          <form
            onSubmit={forgotPasswordOpen ? handleForgotPassword : handleLogin}
            className="login-form"
          >
            <div className="field">
              <label htmlFor="employee-code">Employee Code</label>
              <input
                id="employee-code"
                type="text"
                value={empCode}
                onChange={(event) => setEmpCode(event.target.value.toUpperCase())}
                placeholder="e.g., EMP001"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">
                {forgotPasswordOpen ? 'New Password' : 'Password'}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={forgotPasswordOpen ? 'Minimum 6 characters' : 'EmpCode@123'}
                minLength={forgotPasswordOpen ? 6 : undefined}
                required
              />
            </div>
            {error && <div className="form-error">{error}</div>}
            {authMessage && <div className="form-success">{authMessage}</div>}
            <button type="submit" className="login-btn" disabled={loading}>
              {loading
                ? (forgotPasswordOpen ? 'Saving...' : 'Signing in...')
                : (forgotPasswordOpen ? 'Save New Password' : 'Sign In')}
            </button>
            <button type="button" className="auth-link" onClick={toggleForgotPassword}>
              {forgotPasswordOpen ? 'Back to Sign In' : 'Forgot Password?'}
            </button>
          </form>
          {!forgotPasswordOpen && (
            <p className="login-hint">Default password: Your EmpCode@123</p>
          )}
        </div>
      </div>
    );
  }

  const [year, month] = selectedMonth.split('-').map(Number);
  const summary = buildSummary(year, month, attendanceByDate, holidayByDate, today);
  const isAdmin = role.toLowerCase() === 'admin' || role.toLowerCase() === 'superadmin';
  const isSuperAdmin = role.toLowerCase() === 'superadmin';
  const canManageQueries = isManager || role.toLowerCase() === 'manager';

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="header-left">
          <img src="/maslogo.png" alt="MAS Logo" className="header-logo" />
          <span className="header-title">Biometric Attendance</span>
        </div>
        <div className="header-center">
          {employeeName && <span className="emp-name">{employeeName}</span>}
        </div>
        <div className="header-right">
          <button
            type="button"
            className="profile-btn"
            ref={profileButtonRef}
            aria-label="Open profile"
            aria-expanded={profileOpen}
            onClick={() => {
              if (!profileOpen) fetchProfile();
              setProfileOpen((open) => !open);
            }}
          >
            {employeeName
              ? employeeName.split(' ').map((name) => name[0]).join('').slice(0, 2)
              : 'PR'}
          </button>
          <label className="month-wrap">
            <span className="month-lbl">Month</span>
            <input
              type="month"
              max={currentMonth}
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
              className="month-input"
            />
          </label>
          <button type="button" className="logout-btn" onClick={handleLogout}>Logout</button>
        </div>

        {profileOpen && (
          <div className="profile-popup" ref={profilePopupRef}>
            <div className="profile-row"><span>Name</span><strong>{employeeName}</strong></div>
            <div className="profile-row"><span>Emp Code</span><strong>{employeeCode}</strong></div>
            <div className="profile-row"><span>Designation</span><strong>{designation}</strong></div>
            <div className="profile-row"><span>Role</span><strong>{role || 'Employee'}</strong></div>
            <div className="profile-actions">
              <button
                className="profile-action profile-action-support"
                type="button"
                onClick={() => {
                  setShowSupportPanel((visible) => !visible);
                  setShowManagerQueries(false);
                  setShowHolidayPanel(false);
                  setShowEmployeePanel(false);
                  setProfileOpen(false);
                  setSupportMessage('');
                }}
              >
                {showSupportPanel ? 'Hide Support' : 'Support / Help'}
              </button>
              {canManageQueries && (
                <button
                  className="profile-action profile-action-manager"
                  type="button"
                  onClick={() => {
                    setShowManagerQueries((visible) => !visible);
                    setShowSupportPanel(false);
                    setShowHolidayPanel(false);
                    setShowEmployeePanel(false);
                    setProfileOpen(false);
                    setSupportMessage('');
                    fetchManagerQueries();
                  }}
                >
                  {showManagerQueries ? 'Hide Query Bucket' : 'Query Bucket'}
                </button>
              )}
            </div>
            {isAdmin && (
              <div className="profile-actions">
                <button
                  className="profile-action"
                  type="button"
                  onClick={() => {
                    setShowHolidayPanel((visible) => !visible);
                    setShowEmployeePanel(false);
                    setProfileOpen(false);
                  }}
                >
                  {showHolidayPanel ? 'Hide Holiday Panel' : 'Add Holiday'}
                </button>
                <button
                  className="profile-action profile-action-secondary"
                  type="button"
                  onClick={() => {
                    setShowEmployeePanel((visible) => !visible);
                    setShowHolidayPanel(false);
                    setProfileOpen(false);
                    fetchEmployees();
                  }}
                >
                  {showEmployeePanel ? 'Hide Employees' : 'Manage Employees'}
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {isSuperAdmin && (
        <div className="search-row" style={{ display: 'flex', gap: '10px', padding: '10px 20px', alignItems: 'center', background: '#fff', borderBottom: '1px solid #eee', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search by Emp Code"
            value={searchEmpCode}
            onChange={(event) => { setSearchEmpCode(event.target.value.toUpperCase()); setSearchEmpName(''); }}
            style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #ccc', minWidth: '160px' }}
          />
          <input
            type="text"
            placeholder="Search by Name"
            value={searchEmpName}
            onChange={(event) => { setSearchEmpName(event.target.value); setSearchEmpCode(''); }}
            style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #ccc', minWidth: '160px' }}
          />
          <button
            type="button"
            onClick={() => setSearchVersion((v) => v + 1)}
            style={{ padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', background: '#1976d2', color: '#fff', border: 'none' }}
          >
            Search
          </button>
          {(searchEmpCode || searchEmpName) && (
            <button
              type="button"
              onClick={() => {
                setSearchEmpCode('');
                setSearchEmpName('');
                setSearchVersion((v) => v + 1);
              }}
              style={{ padding: '6px 14px', borderRadius: '4px', cursor: 'pointer', background: '#e0e0e0', border: 'none' }}
            >
              Clear
            </button>
          )}
          {searchMessage && (
            <span style={{ marginLeft: 'auto', color: '#2e7d32', fontWeight: 500 }}>{searchMessage}</span>
          )}
        </div>
      )}

      {showSupportPanel && (
        <section className="support-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Employee Support</span>
              <h3>Ask Your Manager</h3>
            </div>
            <span className="support-note">Image optional, maximum 5 MB</span>
          </div>
          <form className="support-form" onSubmit={sendSupportQuery}>
            <label>
              <span>Problem or query</span>
              <textarea
                value={supportText}
                onChange={(event) => setSupportText(event.target.value)}
                placeholder="Describe the issue clearly..."
                maxLength={5000}
                required
              />
            </label>
            <label>
              <span>Attach image</span>
              <input
                key={supportFileKey}
                type="file"
                accept="image/*"
                onChange={(event) => setSupportImage(event.target.files?.[0] || null)}
              />
            </label>
            <button type="submit" disabled={supportLoading}>
              {supportLoading ? 'Sending...' : 'Send to Manager'}
            </button>
          </form>
          {supportMessage && <div className="support-message" role="status">{supportMessage}</div>}
          <div className="query-list">
            {supportQueries.map((query) => (
              <article className="query-card" key={query.id}>
                <div className="query-card-head">
                  <strong>To: {query.manager_name}</strong>
                  <span className={`query-status status-${query.status.toLowerCase()}`}>
                    {query.status}
                  </span>
                </div>
                <p>{query.query_text}</p>
                <div className="query-meta">
                  <span>Sent {formatDateTime(query.created_at)}</span>
                  {query.solved_at && <span>Solved {formatDateTime(query.solved_at)}</span>}
                  {query.has_image && (
                    <button type="button" onClick={() => openSupportImage(query.id)}>
                      View image
                    </button>
                  )}
                </div>
              </article>
            ))}
            {supportQueries.length === 0 && (
              <div className="empty-list">No support queries sent yet.</div>
            )}
          </div>
        </section>
      )}

      {canManageQueries && showManagerQueries && (
        <section className="support-panel manager-query-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Manager Portal</span>
              <h3>Employee Query Bucket</h3>
            </div>
            <span className="support-note">
              {managerQueries.filter((query) => query.status === 'Open').length} open
            </span>
          </div>
          {supportMessage && <div className="support-message" role="status">{supportMessage}</div>}
          <div className="query-list">
            {managerQueries.map((query) => (
              <article className="query-card" key={query.id}>
                <div className="query-card-head">
                  <strong>{query.employee_name} ({query.employee_emp_code})</strong>
                  <span className={`query-status status-${query.status.toLowerCase()}`}>
                    {query.status}
                  </span>
                </div>
                <p>{query.query_text}</p>
                <div className="query-meta">
                  <span>Received {formatDateTime(query.created_at)}</span>
                  {query.has_image && (
                    <button type="button" onClick={() => openSupportImage(query.id)}>
                      View image
                    </button>
                  )}
                  {query.status === 'Open' && (
                    <button
                      type="button"
                      className="solve-query-btn"
                      onClick={() => solveSupportQuery(query.id)}
                    >
                      Mark Solved
                    </button>
                  )}
                  {query.solved_at && <span>Solved {formatDateTime(query.solved_at)}</span>}
                </div>
              </article>
            ))}
            {managerQueries.length === 0 && (
              <div className="empty-list">No employee queries assigned to you.</div>
            )}
          </div>
        </section>
      )}

      <div className="stats-row">
        <div className="stat-card"><div className="stat-icon si-present">P</div><div className="stat-num sn-present">{summary.present}</div><div className="stat-lbl">Present</div><div className="stat-bar sb-present" /></div>
        <div className="stat-card"><div className="stat-icon si-halfday">HD</div><div className="stat-num sn-halfday">{summary.halfDay}</div><div className="stat-lbl">Half Day</div><div className="stat-bar sb-halfday" /></div>
        <div className="stat-card"><div className="stat-icon si-absent">A</div><div className="stat-num sn-absent">{summary.absent}</div><div className="stat-lbl">Absent / Short</div><div className="stat-bar sb-absent" /></div>
      </div>

      {isAdmin && showHolidayPanel && (
        <div className="admin-panel">
          <h3>Manage Holidays</h3>
          <form onSubmit={createHoliday} className="holiday-form">
            <input type="date" value={newHolidayDate} onChange={(event) => setNewHolidayDate(event.target.value)} required />
            <input type="text" placeholder="Reason (e.g., Republic Day)" value={newHolidayReason} onChange={(event) => setNewHolidayReason(event.target.value)} required />
            <button type="submit">{editingHolidayId ? 'Update Holiday' : 'Add Holiday'}</button>
            {editingHolidayId && (
              <button type="button" className="cancel-btn" onClick={cancelHolidayEdit}>Cancel</button>
            )}
          </form>
          <div className="holiday-list">
            {holidays.map((holiday) => (
              <div key={holiday.id} className="holiday-item">
                <span>{holiday.holiday_date} - {holiday.reason}</span>
                <div className="list-actions">
                  <button type="button" className="edit-btn" aria-label={`Edit ${holiday.reason}`} onClick={() => editHoliday(holiday)}>Edit</button>
                  <button type="button" aria-label={`Delete ${holiday.reason}`} onClick={() => deleteHoliday(holiday.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isAdmin && showEmployeePanel && (
        <section className="admin-panel employee-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Administration</span>
              <h3>{editingEmployeeId ? 'Edit Employee' : 'Add Employee'}</h3>
            </div>
            <span className="auto-id-note">ID: Auto generated</span>
          </div>
          <form onSubmit={saveEmployee} className="employee-form">
            <label>
              <span>Employee Name</span>
              <input
                type="text"
                value={newEmployee.emp_name}
                onChange={(event) => updateNewEmployee('emp_name', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Designation</span>
              <input
                type="text"
                value={newEmployee.designation}
                onChange={(event) => updateNewEmployee('designation', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Role</span>
              <select
                value={newEmployee.role}
                onChange={(event) => updateNewEmployee('role', event.target.value)}
              >
                <option value="Employee">Employee</option>
                <option value="Admin">Admin</option>
                <option value="SuperAdmin">SuperAdmin</option>
              </select>
            </label>
            <label>
              <span>Employee Code</span>
              <input
                type="text"
                value={newEmployee.emp_code}
                onChange={(event) => updateNewEmployee('emp_code', event.target.value.toUpperCase())}
                required
              />
            </label>
            <button type="submit">{editingEmployeeId ? 'Update Employee' : 'Add Employee'}</button>
            {editingEmployeeId && (
              <button type="button" className="cancel-btn" onClick={cancelEmployeeEdit}>Cancel</button>
            )}
          </form>
          {employeeFormMessage && (
            <div className="employee-form-message" role="status">{employeeFormMessage}</div>
          )}
          <div className="employee-list">
            <div className="employee-list-head">
              <span>ID</span>
              <span>Employee</span>
              <span>Designation</span>
              <span>Role</span>
              <span>Emp Code</span>
              <span>Action</span>
            </div>
            {employees.map((employee) => (
              <div className="employee-list-row" key={employee.id}>
                <span>{employee.id}</span>
                <strong>{employee.emp_name}</strong>
                <span>{employee.designation}</span>
                <span>{employee.role}</span>
                <span>{employee.emp_code}</span>
                <button type="button" className="edit-btn" onClick={() => editEmployee(employee)}>
                  Edit
                </button>
              </div>
            ))}
            {employees.length === 0 && (
              <div className="empty-list">No employees found.</div>
            )}
          </div>
        </section>
      )}

      {isSuperAdmin && !loading && attendance.length > 0 && (
        (() => {
          const uniqueIds = [...new Set(attendance.map((r) => r.UserID))];
          if (uniqueIds.length <= 1) return null;
          return (
            <div className="admin-panel" style={{ marginTop: '10px' }}>
              <h3>Search Results</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>Name</th>
                    <th style={{ padding: '8px' }}>Emp Code</th>
                    <th style={{ padding: '8px' }}>Designation</th>
                    <th style={{ padding: '8px' }}>Present</th>
                    <th style={{ padding: '8px' }}>Half Day</th>
                    <th style={{ padding: '8px' }}>Absent</th>
                    <th style={{ padding: '8px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {uniqueIds.map((uid) => {
                    const empRecords = attendance.filter((r) => r.UserID === uid);
                    const empName = empRecords[0]?.Name || uid;
                    const empDesig = empRecords[0]?.Designation || 'Not specified';
                    const empAttendanceByDate = {};
                    empRecords.forEach((r) => { empAttendanceByDate[r.AttendanceDate] = r; });
                    const empSummary = buildSummary(year, month, empAttendanceByDate, holidayByDate, today);
                    return (
                      <tr key={uid} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '8px' }}>{empName}</td>
                        <td style={{ padding: '8px' }}>{uid}</td>
                        <td style={{ padding: '8px' }}>{empDesig}</td>
                        <td style={{ padding: '8px' }}>{empSummary.present}</td>
                        <td style={{ padding: '8px' }}>{empSummary.halfDay}</td>
                        <td style={{ padding: '8px' }}>{empSummary.absent}</td>
                        <td style={{ padding: '8px' }}>
                          <button
                            type="button"
                            onClick={() => {
                              setSearchEmpCode(uid);
                              setSearchEmpName('');
                              setSearchVersion((v) => v + 1);
                            }}
                            style={{ padding: '4px 10px', cursor: 'pointer', background: '#1976d2', color: '#fff', border: 'none', borderRadius: '4px' }}
                          >
                            View Calendar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()
      )}

      {loading && <div className="loader">Loading...</div>}
      {error && <div className="dash-error">{error}</div>}
      {!loading && (
        <div className="cal-card">
          <Calendar
            activeStartDate={new Date(year, month - 1, 1)}
            calendarType="gregory"
            locale="en-US"
            maxDate={today}
            maxDetail="month"
            minDetail="year"
            showNeighboringMonth={false}
            tileContent={tileContent}
            onActiveStartDateChange={({ activeStartDate }) => {
              if (!activeStartDate) return;
              const nextMonth = `${activeStartDate.getFullYear()}-${String(activeStartDate.getMonth() + 1).padStart(2, '0')}`;
              if (nextMonth <= currentMonth) setSelectedMonth(nextMonth);
            }}
            className="att-cal"
          />
          <div className="cal-legend">
            <span className="legend-item"><i className="ldot ld-present" /> Present (9h or more)</span>
            <span className="legend-item"><i className="ldot ld-halfday" /> Half Day (4.5-9h)</span>
            <span className="legend-item"><i className="ldot ld-absent" /> Absent/Short (&lt;4.5h)</span>
            <span className="legend-item"><i className="ldot ld-holiday" /> Holiday</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
