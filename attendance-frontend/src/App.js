import React, { useCallback, useEffect, useRef, useState } from 'react';
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';
import './App.css';
import ApplicationAccess from './ApplicationAccess';
import ReportDashboard from './ReportDashboard';
import RosterManagement from './RosterManagement';

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

const getAllowedTasks = (role, isManager = false) => {
  const normalizedRole = String(role || '').toLowerCase();
  if (normalizedRole === 'superadmin') {
    return ['my_report', 'reports', 'roster', 'access', 'employees', 'managers', 'queries', 'password_resets', 'holidays', 'support'];
  }
  if (normalizedRole === 'admin') return ['my_report', 'queries', 'holidays', 'support'];
  if (normalizedRole === 'manager' || isManager) {
    return ['my_report', 'reports', 'roster', 'queries', 'password_resets', 'support'];
  }
  return ['my_report', 'support'];
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

export const getCalendarTileClassName = ({ date, view }) => {
  if (view !== 'month') return '';
  const firstDayOffset = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  const firstRowLastDate = 7 - firstDayOffset;
  return [
    `calendar-column-${date.getDay()}`,
    date.getDate() <= firstRowLastDate ? 'calendar-tooltip-below' : ''
  ].filter(Boolean).join(' ');
};

const parseCsvRow = (line) => {
  const values = [];
  let value = '';
  let quoted = false;
  const delimiter = line.includes('\t') && !line.includes(',') ? '\t' : ',';

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('A bulk row contains an unclosed quote.');
  values.push(value.trim());
  return values;
};

const parseBulkEmployees = (text) => {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length === 0) throw new Error('Paste at least one employee row.');

  const dataRows = rows.filter((line, index) => (
    index !== 0 || parseCsvRow(line)[0].toLowerCase() !== 'employee code'
  ));
  if (dataRows.length === 0) throw new Error('Paste at least one employee row below the header.');
  if (dataRows.length > 500) throw new Error('You can add a maximum of 500 employees at once.');

  return dataRows.map((line, index) => {
    const fields = parseCsvRow(line);
    if (fields.length !== 7) {
      throw new Error(`Bulk row ${index + 1} must contain exactly 7 comma-separated fields.`);
    }
    const [empCode, empName, designation, role, process, lob, status] = fields;
    const roleByName = {
      employee: 'Employee',
      admin: 'Admin',
      superadmin: 'SuperAdmin'
    };
    const normalizedRole = roleByName[String(role || 'Employee').toLowerCase()];
    const normalizedStatus = status
      ? `${status.charAt(0).toUpperCase()}${status.slice(1).toLowerCase()}`
      : 'Active';
    if (!empCode || !empName || !process || !lob) {
      throw new Error(
        `Bulk row ${index + 1} requires Employee Code, Employee Name, Process, and LOBName.`
      );
    }
    if (!normalizedRole) {
      throw new Error(`Bulk row ${index + 1} has an invalid Role.`);
    }
    if (!['Active', 'Inactive'].includes(normalizedStatus)) {
      throw new Error(`Bulk row ${index + 1} has an invalid Status.`);
    }
    return {
      emp_code: empCode.toUpperCase(),
      emp_name: empName,
      designation: designation || 'Executive',
      role: normalizedRole,
      process_name: process,
      lob_name: lob,
      status: normalizedStatus
    };
  });
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
  const [processName, setProcessName] = useState(initialProfile.process_name || '');
  const [lobName, setLobName] = useState(initialProfile.lob_name || '');
  const [profileOpen, setProfileOpen] = useState(false);
  const [showHolidayPanel, setShowHolidayPanel] = useState(false);
  const [showEmployeePanel, setShowEmployeePanel] = useState(false);
  const [showSupportPanel, setShowSupportPanel] = useState(false);
  const [showManagerQueries, setShowManagerQueries] = useState(false);
  const [activeAdminTask, setActiveAdminTask] = useState(null);
  const [isManager, setIsManager] = useState(Boolean(initialProfile.is_manager));
  const [supportQueries, setSupportQueries] = useState([]);
  const [managerQueries, setManagerQueries] = useState([]);
  const [passwordResetRequests, setPasswordResetRequests] = useState([]);
  const [passwordResetMessage, setPasswordResetMessage] = useState('');
  const [supportSubject, setSupportSubject] = useState('');
  const [supportText, setSupportText] = useState('');
  const [supportImage, setSupportImage] = useState(null);
  const [supportFileKey, setSupportFileKey] = useState(0);
  const [supportMessage, setSupportMessage] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [managerQuerySubjectSearch, setManagerQuerySubjectSearch] = useState('');
  const [managerQueryEmpIdSearch, setManagerQueryEmpIdSearch] = useState('');
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
    emp_code: '',
    emp_name: '',
    designation: 'Executive',
    role: 'Employee',
    process_name: '',
    lob_name: '',
    status: 'Active'
  });
  const [employeeFormMessage, setEmployeeFormMessage] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState(null);
  const [bulkEmployeeOpen, setBulkEmployeeOpen] = useState(false);
  const [bulkEmployeeText, setBulkEmployeeText] = useState('');
  const [bulkEmployeeMessage, setBulkEmployeeMessage] = useState('');
  const [employeeIdSearch, setEmployeeIdSearch] = useState('');
  const [employeeNameSearch, setEmployeeNameSearch] = useState('');
  const [employeeSearchActive, setEmployeeSearchActive] = useState(false);
  const [managers, setManagers] = useState([]);
  const [newManager, setNewManager] = useState({
    manager_empcode: '',
    manager_name: '',
    process_name: '',
    manager_unique_code: ''
  });
  const [managerFormMessage, setManagerFormMessage] = useState('');
  const [editingManagerId, setEditingManagerId] = useState(null);
  const [assignmentManager, setAssignmentManager] = useState(null);
  const [assignedManagerEmployees, setAssignedManagerEmployees] = useState([]);
  const [assignmentSearchResults, setAssignmentSearchResults] = useState([]);
  const [assignmentIdSearch, setAssignmentIdSearch] = useState('');
  const [assignmentNameSearch, setAssignmentNameSearch] = useState('');
  const [assignmentBulkCodes, setAssignmentBulkCodes] = useState('');
  const [agentProcessOptions, setAgentProcessOptions] = useState({
    processes: [],
    lobs: [],
    lobsByProcess: {}
  });
  const [assignmentGroupType, setAssignmentGroupType] = useState('process');
  const [assignmentGroupProcess, setAssignmentGroupProcess] = useState('');
  const [assignmentGroupValue, setAssignmentGroupValue] = useState('');
  const [selectedAvailableEmployeeIds, setSelectedAvailableEmployeeIds] = useState([]);
  const [selectedAssignedEmployeeIds, setSelectedAssignedEmployeeIds] = useState([]);
  const [assignmentMessage, setAssignmentMessage] = useState('');
  const [assignmentAvailableOffset, setAssignmentAvailableOffset] = useState(0);
  const [assignmentHasMore, setAssignmentHasMore] = useState(false);
  const [searchEmpCode, setSearchEmpCode] = useState('');
  const [searchEmpName, setSearchEmpName] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchMessage, setSearchMessage] = useState('');
  const [attendanceSearchOpen, setAttendanceSearchOpen] = useState(false);
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

  useEffect(() => {
    if (activeAdminTask && !getAllowedTasks(role, isManager).includes(activeAdminTask)) {
      setActiveAdminTask(null);
    }
  }, [activeAdminTask, isManager, role]);

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
    setProcessName('');
    setLobName('');
    setProfileOpen(false);
    setShowHolidayPanel(false);
    setShowEmployeePanel(false);
    setShowSupportPanel(false);
    setShowManagerQueries(false);
    setActiveAdminTask(null);
    setIsManager(false);
    setSupportQueries([]);
    setManagerQueries([]);
    setPasswordResetRequests([]);
    setPasswordResetMessage('');
    setSupportSubject('');
    setSupportText('');
    setSupportImage(null);
    setSupportMessage('');
    setManagerQuerySubjectSearch('');
    setManagerQueryEmpIdSearch('');
    setEmployeeFormMessage('');
    setEditingEmployeeId(null);
    setNewEmployee({
      emp_code: '',
      emp_name: '',
      designation: 'Executive',
      role: 'Employee',
      process_name: '',
      lob_name: '',
      status: 'Active'
    });
    setBulkEmployeeOpen(false);
    setBulkEmployeeText('');
    setBulkEmployeeMessage('');
    setEmployeeIdSearch('');
    setEmployeeNameSearch('');
    setEmployeeSearchActive(false);
    setManagers([]);
    setNewManager({
      manager_empcode: '',
      manager_name: '',
      process_name: '',
      manager_unique_code: ''
    });
    setManagerFormMessage('');
    setEditingManagerId(null);
    setAssignmentManager(null);
    setAssignedManagerEmployees([]);
    setAssignmentSearchResults([]);
    setAssignmentIdSearch('');
    setAssignmentNameSearch('');
    setAssignmentBulkCodes('');
    setAgentProcessOptions({ processes: [], lobs: [], lobsByProcess: {} });
    setAssignmentGroupType('process');
    setAssignmentGroupProcess('');
    setAssignmentGroupValue('');
    setSelectedAvailableEmployeeIds([]);
    setSelectedAssignedEmployeeIds([]);
    setAssignmentMessage('');
    setAssignmentAvailableOffset(0);
    setAssignmentHasMore(false);
    setEditingHolidayId(null);
    setSearchEmpCode('');
    setSearchEmpName('');
    setSearchVersion(0);
    setSearchMessage('');
    setAttendanceSearchOpen(false);
    setError('');
  }, []);

  const roleRef = useRef(role);
  useEffect(() => { roleRef.current = role; }, [role]);
  const searchEmpCodeRef = useRef(searchEmpCode);
  useEffect(() => { searchEmpCodeRef.current = searchEmpCode; }, [searchEmpCode]);
  const searchEmpNameRef = useRef(searchEmpName);
  useEffect(() => { searchEmpNameRef.current = searchEmpName; }, [searchEmpName]);
  const attendanceRefreshInFlightRef = useRef(false);

  const fetchAttendance = useCallback(async ({ silent = false } = {}) => {
    if (attendanceRefreshInFlightRef.current) return;
    attendanceRefreshInFlightRef.current = true;
    if (!silent) {
      setLoading(true);
      setError('');
      setSearchMessage('');
    }
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
      if (!silent) setError(requestError.message);
    } finally {
      attendanceRefreshInFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [handleLogout, selectedMonth, token]);

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
      setProcessName(data.process_name || '');
      setLobName(data.lob_name || '');
      setIsManager(Boolean(data.is_manager));
      saveProfile(data);
    } catch {}
  }, [handleLogout, token]);

  const fetchEmployees = useCallback(async (idSearch = '', nameSearch = '') => {
    try {
      const params = new URLSearchParams();
      if (idSearch.trim()) params.set('search_id', idSearch.trim());
      if (nameSearch.trim()) params.set('search_name', nameSearch.trim());
      const query = params.toString();
      const response = await fetch(`${API_BASE_URL}/api/employees${query ? `?${query}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to load employees');
      const data = await response.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setEmployeeFormMessage(requestError.message);
    }
  }, [token]);

  const fetchManagers = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/managers`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(data.detail || 'Failed to load managers');
      setManagers(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setManagerFormMessage(requestError.message);
    }
  }, [token]);

  const fetchAssignedEmployees = useCallback(async (
    managerId,
    idSearch = '',
    nameSearch = ''
  ) => {
    try {
      const params = new URLSearchParams({ assigned_only: 'true' });
      if (idSearch.trim()) params.set('search_id', idSearch.trim());
      if (nameSearch.trim()) params.set('search_name', nameSearch.trim());
      const response = await fetch(
        `${API_BASE_URL}/api/managers/${managerId}/assignment-employees?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(data.detail || 'Failed to load employee assignments');
      setAssignedManagerEmployees(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setAssignmentMessage(requestError.message);
    }
  }, [token]);

  const fetchAvailableEmployees = useCallback(async (
    managerId,
    idSearch = '',
    nameSearch = '',
    offset = 0,
    append = false,
    bulkCodes = '',
    groupType = '',
    groupValue = '',
    groupProcess = ''
  ) => {
    try {
      const resultLimit = groupValue.trim() ? 1000 : 100;
      const params = new URLSearchParams({
        limit: String(resultLimit),
        offset: String(offset)
      });
      if (idSearch.trim()) params.set('search_id', idSearch.trim());
      if (nameSearch.trim()) params.set('search_name', nameSearch.trim());
      if (bulkCodes.trim()) params.set('emp_codes', bulkCodes.trim());
      if (groupType === 'process' && groupValue.trim()) {
        params.set('process_name', groupValue.trim());
      }
      if (groupType === 'lob' && groupValue.trim()) {
        if (groupProcess.trim()) params.set('process_name', groupProcess.trim());
        params.set('lob_name', groupValue.trim());
      }
      const response = await fetch(
        `${API_BASE_URL}/api/managers/${managerId}/assignment-employees?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json().catch(() => ([]));
      if (!response.ok) throw new Error(data.detail || 'Failed to load available employees');
      const rows = Array.isArray(data) ? data : [];
      setAssignmentSearchResults((currentRows) => (
        append ? [...currentRows, ...rows] : rows
      ));
      setAssignmentAvailableOffset(offset + rows.length);
      setAssignmentHasMore(rows.length === resultLimit);
      return rows;
    } catch (requestError) {
      setAssignmentMessage(requestError.message);
      return [];
    }
  }, [token]);

  const fetchAgentProcessOptions = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/agent-process/options`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to load Process and LOB options');
      }
      setAgentProcessOptions({
        processes: Array.isArray(data.processes) ? data.processes : [],
        lobs: Array.isArray(data.lobs) ? data.lobs : [],
        lobsByProcess: (
          data.lobs_by_process
          && typeof data.lobs_by_process === 'object'
          && !Array.isArray(data.lobs_by_process)
        ) ? data.lobs_by_process : {}
      });
    } catch (requestError) {
      setAssignmentMessage(requestError.message);
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

  const fetchManagerQueries = useCallback(async ({ silent = false } = {}) => {
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
      if (!silent) setSupportMessage(requestError.message);
    }
  }, [handleLogout, token]);

  const fetchPasswordResetRequests = useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/manager/password-reset-requests`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401) {
        handleLogout();
        return;
      }
      const data = await response.json().catch(() => ([]));
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to load password reset requests');
      }
      setPasswordResetRequests(Array.isArray(data) ? data : []);
    } catch (requestError) {
      if (!silent) setPasswordResetMessage(requestError.message);
    }
  }, [handleLogout, token]);

  useEffect(() => {
    if (!token) return;
    fetchAttendance();
    fetchHolidays();
    fetchProfile();
  }, [fetchAttendance, fetchHolidays, fetchProfile, searchVersion, token]);

  useEffect(() => {
    if (!token || activeAdminTask) return undefined;
    const refreshTimer = window.setInterval(() => {
      fetchAttendance({ silent: true });
    }, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [activeAdminTask, fetchAttendance, token]);

  useEffect(() => {
    if (!token || (!showSupportPanel && activeAdminTask !== 'support')) return undefined;
    fetchSupportQueries();
    const refreshTimer = window.setInterval(fetchSupportQueries, 15000);
    return () => window.clearInterval(refreshTimer);
  }, [activeAdminTask, fetchSupportQueries, showSupportPanel, token]);

  useEffect(() => {
    if (!token) return undefined;
    const allowedNotificationTasks = getAllowedTasks(role, isManager);
    const refreshNotifications = () => {
      if (allowedNotificationTasks.includes('queries')) {
        fetchManagerQueries({ silent: true });
      }
      if (allowedNotificationTasks.includes('password_resets')) {
        fetchPasswordResetRequests({ silent: true });
      }
    };

    refreshNotifications();
    const refreshTimer = window.setInterval(refreshNotifications, 15000);
    return () => window.clearInterval(refreshTimer);
  }, [
    fetchManagerQueries,
    fetchPasswordResetRequests,
    isManager,
    role,
    token
  ]);

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
      setProcessName('');
      setLobName('');
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
        throw new Error(data.detail || 'Failed to request password reset');
      }

      setForgotPasswordOpen(false);
      setPassword('');
      setAuthMessage(
        data.message
        || 'Password reset request sent. You can use the new password after manager approval.'
      );
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
        emp_code: '',
        emp_name: '',
        designation: 'Executive',
        role: 'Employee',
        process_name: '',
        lob_name: '',
        status: 'Active'
      });
      setEditingEmployeeId(null);
      setEmployeeSearchActive(false);
      fetchEmployees();
    } catch (requestError) {
      setEmployeeFormMessage(requestError.message);
    }
  };

  const updateNewEmployee = (field, value) => {
    setNewEmployee((current) => ({ ...current, [field]: value }));
  };

  const searchEmployees = async () => {
    if (!employeeIdSearch.trim() && !employeeNameSearch.trim()) {
      setEmployeeFormMessage('Enter an Employee ID, code, or name to search.');
      return;
    }
    setEmployeeFormMessage('');
    setEmployeeSearchActive(true);
    await fetchEmployees(employeeIdSearch, employeeNameSearch);
  };

  const editEmployee = (employee) => {
    setEditingEmployeeId(employee.id);
    setBulkEmployeeOpen(false);
    setNewEmployee({
      emp_code: employee.emp_code,
      emp_name: employee.emp_name,
      designation: employee.designation,
      role: employee.role,
      process_name: employee.process_name || '',
      lob_name: employee.lob_name || '',
      status: employee.status || 'Active'
    });
    setEmployeeFormMessage('');
  };

  const cancelEmployeeEdit = () => {
    setEditingEmployeeId(null);
    setNewEmployee({
      emp_code: '',
      emp_name: '',
      designation: 'Executive',
      role: 'Employee',
      process_name: '',
      lob_name: '',
      status: 'Active'
    });
    setEmployeeFormMessage('');
  };

  const saveBulkEmployees = async () => {
    setBulkEmployeeMessage('');
    try {
      const bulkEmployees = parseBulkEmployees(bulkEmployeeText);
      const response = await fetch(`${API_BASE_URL}/api/employees/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ employees: bulkEmployees })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to add bulk employees');

      setBulkEmployeeMessage(`${data.created_count} employee(s) added successfully.`);
      setBulkEmployeeText('');
      setEmployeeSearchActive(false);
      fetchEmployees();
    } catch (requestError) {
      setBulkEmployeeMessage(requestError.message);
    }
  };

  const saveManager = async (event) => {
    event.preventDefault();
    setManagerFormMessage('');

    try {
      const response = await fetch(
        editingManagerId
          ? `${API_BASE_URL}/api/managers/${editingManagerId}`
          : `${API_BASE_URL}/api/managers`,
        {
        method: editingManagerId ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(newManager)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to save manager');

      setManagerFormMessage(
        `Manager ${data.manager_empcode} ${editingManagerId ? 'updated' : 'added'} successfully with ID ${data.id}.`
      );
      setNewManager({
        manager_empcode: '',
        manager_name: '',
        process_name: '',
        manager_unique_code: ''
      });
      setEditingManagerId(null);
      fetchManagers();
    } catch (requestError) {
      setManagerFormMessage(requestError.message);
    }
  };

  const updateNewManager = (field, value) => {
    setNewManager((current) => ({ ...current, [field]: value }));
  };

  const editManager = (manager) => {
    setEditingManagerId(manager.id);
    setNewManager({
      manager_empcode: manager.manager_empcode,
      manager_name: manager.manager_name,
      process_name: manager.process_name,
      manager_unique_code: manager.manager_unique_code
    });
    setManagerFormMessage('');
  };

  const cancelManagerEdit = () => {
    setEditingManagerId(null);
    setNewManager({
      manager_empcode: '',
      manager_name: '',
      process_name: '',
      manager_unique_code: ''
    });
    setManagerFormMessage('');
  };

  const deleteManager = async (manager) => {
    if (!window.confirm(`Delete manager ${manager.manager_name}?`)) return;

    setManagerFormMessage('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/managers/${manager.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to delete manager');

      if (editingManagerId === manager.id) cancelManagerEdit();
      setManagers((currentManagers) => (
        currentManagers.filter((currentManager) => currentManager.id !== manager.id)
      ));
      setManagerFormMessage(`Manager ${manager.manager_empcode} deleted successfully.`);
    } catch (requestError) {
      setManagerFormMessage(requestError.message);
    }
  };

  const openEmployeeAssignment = (manager) => {
    setAssignmentManager(manager);
    setAssignedManagerEmployees([]);
    setAssignmentSearchResults([]);
    setAssignmentIdSearch('');
    setAssignmentNameSearch('');
    setAssignmentBulkCodes('');
    setAssignmentGroupType('process');
    setAssignmentGroupProcess('');
    setAssignmentGroupValue('');
    setSelectedAvailableEmployeeIds([]);
    setSelectedAssignedEmployeeIds([]);
    setAssignmentMessage('');
    setAssignmentAvailableOffset(0);
    setAssignmentHasMore(false);
    fetchAgentProcessOptions();
    fetchAssignedEmployees(manager.id);
    fetchAvailableEmployees(manager.id);
  };

  const closeEmployeeAssignment = () => {
    setAssignmentManager(null);
    setAssignedManagerEmployees([]);
    setAssignmentSearchResults([]);
    setAssignmentBulkCodes('');
    setAssignmentGroupType('process');
    setAssignmentGroupProcess('');
    setAssignmentGroupValue('');
    setSelectedAvailableEmployeeIds([]);
    setSelectedAssignedEmployeeIds([]);
    setAssignmentMessage('');
    setAssignmentAvailableOffset(0);
    setAssignmentHasMore(false);
  };

  const searchAssignmentEmployees = async (preserveMessage = false) => {
    if (!assignmentManager) return;
    const idSearch = assignmentIdSearch.trim();
    const nameSearch = assignmentNameSearch.trim();
    if (!preserveMessage) setAssignmentMessage('');
    setAssignmentBulkCodes('');
    setAssignmentGroupProcess('');
    setAssignmentGroupValue('');
    try {
      await fetchAvailableEmployees(
        assignmentManager.id,
        idSearch,
        nameSearch,
        0,
        false
      );
      setSelectedAvailableEmployeeIds([]);
      await fetchAssignedEmployees(assignmentManager.id, idSearch, nameSearch);
      setSelectedAssignedEmployeeIds([]);
    } catch (requestError) {
      setAssignmentMessage(requestError.message);
    }
  };

  const searchAssignmentBulkCodes = async () => {
    if (!assignmentManager) return;
    const codes = [...new Set(
      assignmentBulkCodes
        .split(',')
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean)
    )];
    if (codes.length === 0) {
      setAssignmentMessage('Paste at least one employee code.');
      return;
    }
    if (codes.length > 100) {
      setAssignmentMessage('You can search a maximum of 100 employee codes at once.');
      return;
    }

    const normalizedCodes = codes.join(',');
    setAssignmentBulkCodes(normalizedCodes);
    setAssignmentGroupProcess('');
    setAssignmentGroupValue('');
    setAssignmentIdSearch('');
    setAssignmentNameSearch('');
    setAssignmentMessage('');
    setSelectedAvailableEmployeeIds([]);
    setSelectedAssignedEmployeeIds([]);
    await fetchAvailableEmployees(
      assignmentManager.id,
      '',
      '',
      0,
      false,
      normalizedCodes
    );
  };

  const searchAssignmentGroup = async () => {
    if (!assignmentManager) return;
    const groupProcess = assignmentGroupProcess.trim();
    const groupValue = assignmentGroupValue.trim();
    if (assignmentGroupType === 'lob' && !groupProcess) {
      setAssignmentMessage('Select a Process first.');
      return;
    }
    if (!groupValue) {
      setAssignmentMessage(
        `Select a ${assignmentGroupType === 'process' ? 'Process' : 'LOB'} first.`
      );
      return;
    }

    setAssignmentIdSearch('');
    setAssignmentNameSearch('');
    setAssignmentBulkCodes('');
    setAssignmentMessage('');
    setSelectedAssignedEmployeeIds([]);
    const rows = await fetchAvailableEmployees(
      assignmentManager.id,
      '',
      '',
      0,
      false,
      '',
      assignmentGroupType,
      groupValue,
      groupProcess
    );
    setSelectedAvailableEmployeeIds(rows.map((employee) => employee.id));
    if (rows.length === 0) {
      setAssignmentMessage(
        `No available employees found for this ${assignmentGroupType === 'process' ? 'Process' : 'LOB'}.`
      );
    }
  };

  const toggleEmployeeSelection = (employeeId, assigned) => {
    const setter = assigned ? setSelectedAssignedEmployeeIds : setSelectedAvailableEmployeeIds;
    setter((currentIds) => (
      currentIds.includes(employeeId)
        ? currentIds.filter((id) => id !== employeeId)
        : [...currentIds, employeeId]
    ));
  };

  const updateEmployeeAssignments = async (action) => {
    if (!assignmentManager) return;
    const employeeIds = action === 'assign'
      ? selectedAvailableEmployeeIds
      : selectedAssignedEmployeeIds;
    if (employeeIds.length === 0) return;

    const sourceEmployees = action === 'assign'
      ? assignmentSearchResults
      : assignedManagerEmployees;
    const selectedEmployees = sourceEmployees.filter((employee) => employeeIds.includes(employee.id));
    const movingEmployees = action === 'assign' && selectedEmployees.some((employee) => (
      employee.assigned_manager_unique_code
      && employee.assigned_manager_unique_code !== assignmentManager.manager_unique_code
    ));
    if (
      movingEmployees
      && !window.confirm('Some selected employees already have a manager. Move them to this manager?')
    ) {
      return;
    }

    setAssignmentMessage('');
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/managers/${assignmentManager.id}/${action}-employees`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ employee_ids: employeeIds })
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to update assignments');

      setAssignmentMessage(data.message || 'Employee assignments updated.');
      setSelectedAvailableEmployeeIds([]);
      setSelectedAssignedEmployeeIds([]);
      await fetchAssignedEmployees(
        assignmentManager.id,
        assignmentIdSearch,
        assignmentNameSearch
      );
      await fetchManagers();
      if (assignmentIdSearch.trim() || assignmentNameSearch.trim()) {
        await searchAssignmentEmployees(true);
      } else if (assignmentBulkCodes.trim()) {
        await fetchAvailableEmployees(
          assignmentManager.id,
          '',
          '',
          0,
          false,
          assignmentBulkCodes
        );
      } else if (assignmentGroupValue.trim()) {
        const rows = await fetchAvailableEmployees(
          assignmentManager.id,
          '',
          '',
          0,
          false,
          '',
          assignmentGroupType,
          assignmentGroupValue,
          assignmentGroupProcess
        );
        setSelectedAvailableEmployeeIds(rows.map((employee) => employee.id));
      } else {
        await fetchAvailableEmployees(assignmentManager.id);
      }
    } catch (requestError) {
      setAssignmentMessage(requestError.message);
    }
  };

  const sendSupportQuery = async (event) => {
    event.preventDefault();
    if (!supportSubject.trim() || !supportText.trim()) return;

    setSupportLoading(true);
    setSupportMessage('');
    const formData = new FormData();
    formData.append('query_subject', supportSubject.trim());
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
      setSupportSubject('');
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

  const reviewPasswordReset = async (requestId, action) => {
    const actionLabel = action === 'approve' ? 'approve' : 'reject';
    if (!window.confirm(`${actionLabel[0].toUpperCase()}${actionLabel.slice(1)} this password reset request?`)) {
      return;
    }

    setPasswordResetMessage('');
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/manager/password-reset-requests/${requestId}/${action}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || `Failed to ${actionLabel} password reset request`);
      }
      setPasswordResetRequests((requests) => (
        requests.map((request) => (request.id === requestId ? data : request))
      ));
      setPasswordResetMessage(
        action === 'approve'
          ? 'Password reset approved. The employee can now use the new password.'
          : 'Password reset request rejected.'
      );
    } catch (requestError) {
      setPasswordResetMessage(requestError.message);
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

  const openTask = (task) => {
    if (!getAllowedTasks(role, isManager).includes(task)) return;

    if (task === 'my_report' && role.toLowerCase() === 'superadmin') {
      setSearchEmpCode('');
      setSearchEmpName('');
      setSearchVersion((v) => v + 1);
    }

    setActiveAdminTask(task);
    setProfileOpen(false);
    setShowSupportPanel(false);
    setShowManagerQueries(false);
    setShowHolidayPanel(false);
    setShowEmployeePanel(false);
    setSupportMessage('');
    setPasswordResetMessage('');

    if (task === 'employees') {
      setEmployeeSearchActive(false);
      setEmployees([]);
      fetchEmployees();
    }
    if (task === 'managers') fetchManagers();
    if (task === 'queries') fetchManagerQueries();
    if (task === 'password_resets') fetchPasswordResetRequests();
  };

  const closeTasks = () => {
    setActiveAdminTask(null);
    setSupportMessage('');
    setPasswordResetMessage('');
    setEditingEmployeeId(null);
    setBulkEmployeeOpen(false);
    setBulkEmployeeMessage('');
    setEditingHolidayId(null);
    closeEmployeeAssignment();
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
                ? 'Request a new password from your assigned manager'
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
                ? (forgotPasswordOpen ? 'Sending Request...' : 'Signing in...')
                : (forgotPasswordOpen ? 'Send Reset Request' : 'Sign In')}
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
  const isSuperAdmin = role.toLowerCase() === 'superadmin';
  const allowedTasks = getAllowedTasks(role, isManager);
  const hasEmployeeSearch = employeeSearchActive;
  const filteredEmployees = employees.filter((employee) => {
    const idSearch = employeeIdSearch.trim().toLowerCase();
    const nameSearch = employeeNameSearch.trim().toLowerCase();
    const matchesId = !idSearch
      || String(employee.id).toLowerCase().includes(idSearch)
      || String(employee.emp_code || '').toLowerCase().includes(idSearch);
    const matchesName = !nameSearch
      || String(employee.emp_name || '').toLowerCase().includes(nameSearch);
    return matchesId && matchesName;
  });
  const assignedEmployees = assignedManagerEmployees;
  const availableAssignmentEmployees = assignmentSearchResults;
  const openManagerQueryCount = managerQueries.filter((query) => query.status === 'Open').length;
  const pendingPasswordResetCount = passwordResetRequests.filter(
    (request) => request.status === 'Pending'
  ).length;
  const totalManagerNotificationCount = openManagerQueryCount + pendingPasswordResetCount;
  const displayNotificationCount = (count) => (count > 99 ? '99+' : count);
  const filteredManagerQueries = managerQueries.filter((query) => {
    const subjectSearch = managerQuerySubjectSearch.trim().toLowerCase();
    const empIdSearch = managerQueryEmpIdSearch.trim().toLowerCase();
    const matchesSubject = !subjectSearch
      || String(query.query_subject || 'General Query').toLowerCase().includes(subjectSearch);
    const matchesEmpId = !empIdSearch
      || String(query.employee_emp_code || '').toLowerCase().includes(empIdSearch);
    return matchesSubject && matchesEmpId;
  });

  const buildMyReportRows = () => {
    const [yr, mn] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(yr, mn, 0).getDate();
    const rows = [];
    const LATE_CUTOFF_HOUR = 9;
    const LATE_CUTOFF_MIN = 30;
    const PRESENT_MINUTES = 540;
    const HALF_DAY_MINUTES = 270;

    for (let d = 1; d <= daysInMonth; d += 1) {
      const date = new Date(yr, mn - 1, d);
      const dateKey = toDateKey(date);
      const dayName = date.toLocaleDateString('en-IN', { weekday: 'short' });
      const isSunday = date.getDay() === 0;
      const isFuture = date > today;
      const holiday = holidayByDate[dateKey];
      const record = attendanceByDate[dateKey];

      if (holiday) {
        rows.push({ dateKey, dayName, label: 'Holiday', detail: holiday.reason, cls: 'mr-holiday' });
        continue;
      }
      if (isSunday && (!record || record.WorkingMinutes < HALF_DAY_MINUTES)) {
        rows.push({ dateKey, dayName, label: 'Weekly Off', detail: '', cls: 'mr-off' });
        continue;
      }
      if (isFuture) {
        rows.push({ dateKey, dayName, label: '—', detail: 'Future', cls: 'mr-future' });
        continue;
      }
      if (!record) {
        rows.push({ dateKey, dayName, label: 'Absent', detail: '', cls: 'mr-absent', punchIn: '—', punchOut: '—', loginHours: '—', late: '—', adherence: '—' });
        continue;
      }

      const wm = record.WorkingMinutes;
      let statusLabel = 'Absent';
      let statusCls = 'mr-absent';
      if (wm >= PRESENT_MINUTES) { statusLabel = 'Present'; statusCls = 'mr-present'; }
      else if (wm >= HALF_DAY_MINUTES) { statusLabel = 'Half Day'; statusCls = 'mr-halfday'; }

      let lateLabel = '—';
      let lateCls = '';
      let adherenceLabel = '—';
      if (statusLabel !== 'Absent' && record.FirstPunchIn) {
        const punchTime = new Date(record.FirstPunchIn);
        const isLate = punchTime.getHours() > LATE_CUTOFF_HOUR
          || (punchTime.getHours() === LATE_CUTOFF_HOUR && punchTime.getMinutes() > LATE_CUTOFF_MIN);
        lateLabel = isLate ? 'Late' : 'On Time';
        lateCls = isLate ? 'mr-late' : 'mr-ontime';
        adherenceLabel = wm >= PRESENT_MINUTES ? 'Met' : 'Short';
      }

      rows.push({
        dateKey,
        dayName,
        punchIn: formatTime(record.FirstPunchIn),
        punchOut: formatTime(record.LastPunchOut),
        loginHours: record.WorkingHours,
        label: statusLabel,
        cls: statusCls,
        late: lateLabel,
        lateCls,
        adherence: adherenceLabel
      });
    }
    return rows;
  };

  return (
    <div className={`dashboard ${activeAdminTask ? 'admin-page-open' : ''}`}>
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
            data-notification-count={totalManagerNotificationCount}
            title={
              totalManagerNotificationCount > 0
                ? `${totalManagerNotificationCount} pending notifications`
                : 'Open profile'
            }
            onClick={() => {
              if (!profileOpen) fetchProfile();
              setProfileOpen((open) => !open);
            }}
          >
            {employeeName
              ? employeeName.split(' ').map((name) => name[0]).join('').slice(0, 2)
              : 'PR'}
            {totalManagerNotificationCount > 0 && (
              <span
                className="profile-notification-badge"
                aria-hidden="true"
              >
                {displayNotificationCount(totalManagerNotificationCount)}
              </span>
            )}
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
            {processName && (
              <div className="profile-row"><span>Process</span><strong>{processName}</strong></div>
            )}
            {lobName && (
              <div className="profile-row"><span>LOB</span><strong>{lobName}</strong></div>
            )}
            <div className="profile-actions task-profile-actions">
              {allowedTasks.includes('my_report') && (
                <button
                  className="profile-action profile-action-myreport"
                  type="button"
                  onClick={() => openTask('my_report')}
                >
                  My Report
                </button>
              )}
              {allowedTasks.includes('reports') && (
                <button
                  className="profile-action profile-action-report"
                  type="button"
                  onClick={() => openTask('reports')}
                >
                  View Reports
                </button>
              )}
              {allowedTasks.includes('roster') && (
                <button
                  className="profile-action profile-action-roster"
                  type="button"
                  onClick={() => openTask('roster')}
                >
                  Manage Roster
                </button>
              )}
              {allowedTasks.includes('access') && (
                <button
                  className="profile-action profile-action-access"
                  type="button"
                  onClick={() => openTask('access')}
                >
                  Application Access
                </button>
              )}
              {allowedTasks.includes('employees') && (
                <button
                  className="profile-action profile-action-secondary"
                  type="button"
                  onClick={() => openTask('employees')}
                >
                  Manage Employee
                </button>
              )}
              {allowedTasks.includes('managers') && (
                <button
                  className="profile-action profile-action-manager-add"
                  type="button"
                  onClick={() => openTask('managers')}
                >
                  Add Manager
                </button>
              )}
              {allowedTasks.includes('queries') && (
                <button
                  className="profile-action profile-action-manager"
                  type="button"
                  aria-label="Query Bucket"
                  onClick={() => openTask('queries')}
                >
                  <span>Query Bucket</span>
                  {openManagerQueryCount > 0 && (
                    <span
                      className="task-notification-badge"
                      aria-hidden="true"
                    >
                      {displayNotificationCount(openManagerQueryCount)}
                    </span>
                  )}
                </button>
              )}
              {allowedTasks.includes('password_resets') && (
                <button
                  className="profile-action profile-action-password-reset"
                  type="button"
                  aria-label="Reset Password Requests"
                  onClick={() => openTask('password_resets')}
                >
                  <span>Reset Password Requests</span>
                  {pendingPasswordResetCount > 0 && (
                    <span
                      className="task-notification-badge"
                      aria-hidden="true"
                    >
                      {displayNotificationCount(pendingPasswordResetCount)}
                    </span>
                  )}
                </button>
              )}
              {allowedTasks.includes('holidays') && (
                <button
                  className="profile-action"
                  type="button"
                  onClick={() => openTask('holidays')}
                >
                  Add Holiday
                </button>
              )}
              {allowedTasks.includes('support') && (
                <button
                  className="profile-action profile-action-support"
                  type="button"
                  onClick={() => openTask('support')}
                >
                  Support
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {activeAdminTask && (
        <aside className="admin-task-nav" aria-label="Profile tasks">
          <div className="admin-task-nav-head">
            <span>{role || 'Employee'}</span>
            <strong>Task Center</strong>
          </div>
          {allowedTasks.includes('my_report') && (
            <button
              type="button"
              className={activeAdminTask === 'my_report' ? 'active' : ''}
              onClick={() => openTask('my_report')}
            >
              <span>0</span> My Report
            </button>
          )}
          {allowedTasks.includes('reports') && (
            <button
              type="button"
              className={activeAdminTask === 'reports' ? 'active' : ''}
              onClick={() => openTask('reports')}
            >
              <span>R</span> Reports
            </button>
          )}
          {allowedTasks.includes('roster') && (
            <button
              type="button"
              className={activeAdminTask === 'roster' ? 'active' : ''}
              onClick={() => openTask('roster')}
            >
              <span>S</span> Roster & Shifts
            </button>
          )}
          {allowedTasks.includes('access') && (
            <button
              type="button"
              className={activeAdminTask === 'access' ? 'active' : ''}
              onClick={() => openTask('access')}
            >
              <span>A</span> Application Access
            </button>
          )}
          {allowedTasks.includes('employees') && (
            <button
              type="button"
              className={activeAdminTask === 'employees' ? 'active' : ''}
              onClick={() => openTask('employees')}
            >
              <span>1</span> Manage Employee
            </button>
          )}
          {allowedTasks.includes('managers') && (
            <button
              type="button"
              className={activeAdminTask === 'managers' ? 'active' : ''}
              onClick={() => openTask('managers')}
            >
              <span>2</span> Add Manager
            </button>
          )}
          {allowedTasks.includes('queries') && (
            <button
              type="button"
              className={activeAdminTask === 'queries' ? 'active' : ''}
              aria-label="Query Bucket"
              onClick={() => openTask('queries')}
            >
              <span>{isSuperAdmin ? '3' : '1'}</span>
              <span className="admin-task-label">Query Bucket</span>
              {openManagerQueryCount > 0 && (
                <span
                  className="task-notification-badge"
                  aria-hidden="true"
                >
                  {displayNotificationCount(openManagerQueryCount)}
                </span>
              )}
            </button>
          )}
          {allowedTasks.includes('password_resets') && (
            <button
              type="button"
              className={activeAdminTask === 'password_resets' ? 'active' : ''}
              aria-label="Reset Password Requests"
              onClick={() => openTask('password_resets')}
            >
              <span>{isSuperAdmin ? '4' : '2'}</span>
              <span className="admin-task-label">Reset Password Requests</span>
              {pendingPasswordResetCount > 0 && (
                <span
                  className="task-notification-badge"
                  aria-hidden="true"
                >
                  {displayNotificationCount(pendingPasswordResetCount)}
                </span>
              )}
            </button>
          )}
          {allowedTasks.includes('holidays') && (
            <button
              type="button"
              className={activeAdminTask === 'holidays' ? 'active' : ''}
              onClick={() => openTask('holidays')}
            >
              <span>{isSuperAdmin ? '5' : '2'}</span> Add Holiday
            </button>
          )}
          {allowedTasks.includes('support') && (
            <button
              type="button"
              className={activeAdminTask === 'support' ? 'active' : ''}
              onClick={() => openTask('support')}
            >
              <span>{isSuperAdmin ? '6' : allowedTasks.length}</span> Support
            </button>
          )}
          <button type="button" className="back-dashboard-btn" onClick={closeTasks}>
            Back to Attendance
          </button>
        </aside>
      )}

      {isSuperAdmin && !activeAdminTask && (
        <section className={`attendance-search-card ${attendanceSearchOpen ? 'is-open' : ''}`}>
          <div className="attendance-search-toolbar">
            <div>
              <span className="panel-kicker">SuperAdmin Tools</span>
              <strong>Employee Attendance Search</strong>
              {!attendanceSearchOpen && searchMessage && (
                <small className="attendance-search-summary">{searchMessage}</small>
              )}
            </div>
            <button
              type="button"
              className="attendance-search-toggle"
              aria-expanded={attendanceSearchOpen}
              aria-controls="attendance-search-form"
              onClick={() => setAttendanceSearchOpen((open) => !open)}
            >
              {attendanceSearchOpen ? 'Hide Search' : 'Find Employee'}
            </button>
          </div>

          {attendanceSearchOpen && (
            <div className="attendance-search-form" id="attendance-search-form">
              <label>
                <span>Employee Code</span>
                <input
                  type="search"
                  placeholder="e.g., MAS10001"
                  value={searchEmpCode}
                  onChange={(event) => {
                    setSearchEmpCode(event.target.value.toUpperCase());
                    setSearchEmpName('');
                  }}
                />
              </label>
              <label>
                <span>Employee Name</span>
                <input
                  type="search"
                  placeholder="Search employee name"
                  value={searchEmpName}
                  onChange={(event) => {
                    setSearchEmpName(event.target.value);
                    setSearchEmpCode('');
                  }}
                />
              </label>
              <button
                type="button"
                className="attendance-search-submit"
                disabled={!searchEmpCode.trim() && !searchEmpName.trim()}
                onClick={() => setSearchVersion((version) => version + 1)}
              >
                Search Attendance
              </button>
              {(searchEmpCode || searchEmpName || searchMessage) && (
                <button
                  type="button"
                  className="attendance-search-clear"
                  onClick={() => {
                    setSearchEmpCode('');
                    setSearchEmpName('');
                    setSearchMessage('');
                    setSearchVersion((version) => version + 1);
                  }}
                >
                  Clear
                </button>
              )}
              {searchMessage && (
                <div className="attendance-search-result" role="status">{searchMessage}</div>
              )}
            </div>
          )}
        </section>
      )}

      {(showSupportPanel || activeAdminTask === 'support') && (
        <section className="support-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Employee Support</span>
              <h3>Ask Your Manager</h3>
            </div>
            <span className="support-note">Image optional, maximum 5 MB</span>
          </div>
          <form className="support-form" onSubmit={sendSupportQuery}>
            <label className="support-subject-field">
              <span>Query Subject</span>
              <input
                type="text"
                value={supportSubject}
                onChange={(event) => setSupportSubject(event.target.value)}
                placeholder="e.g., Missing punch for June 12"
                maxLength={255}
                required
              />
            </label>
            <label className="support-message-field">
              <span>Query</span>
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
                <h4 className="query-subject">{query.query_subject || 'General Query'}</h4>
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

      {(showManagerQueries || activeAdminTask === 'queries') && (
        <section className="support-panel manager-query-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Query Management</span>
              <h3>Employee Query Bucket</h3>
            </div>
            <span className="support-note">
              {managerQueries.filter((query) => query.status === 'Open').length} open
            </span>
          </div>
          {supportMessage && <div className="support-message" role="status">{supportMessage}</div>}
          <div className="manager-query-search">
            <label>
              <span>Search by Subject</span>
              <input
                type="search"
                value={managerQuerySubjectSearch}
                onChange={(event) => setManagerQuerySubjectSearch(event.target.value)}
                placeholder="Query subject"
              />
            </label>
            <label>
              <span>Search by Emp ID</span>
              <input
                type="search"
                value={managerQueryEmpIdSearch}
                onChange={(event) => setManagerQueryEmpIdSearch(event.target.value.toUpperCase())}
                placeholder="Employee code"
              />
            </label>
            {(managerQuerySubjectSearch || managerQueryEmpIdSearch) && (
              <button
                type="button"
                onClick={() => {
                  setManagerQuerySubjectSearch('');
                  setManagerQueryEmpIdSearch('');
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div className="query-list">
            {filteredManagerQueries.map((query) => (
              <article className="query-card" key={query.id}>
                <div className="query-card-head">
                  <strong>{query.employee_name} ({query.employee_emp_code})</strong>
                  <span className={`query-status status-${query.status.toLowerCase()}`}>
                    {query.status}
                  </span>
                </div>
                <h4 className="query-subject">{query.query_subject || 'General Query'}</h4>
                <p>{query.query_text}</p>
                <div className="query-meta">
                  <span>Received {formatDateTime(query.created_at)}</span>
                  <span>Manager: {query.manager_name}</span>
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
            {filteredManagerQueries.length === 0 && (
              <div className="empty-list">
                {managerQueries.length === 0
                  ? 'No employee queries found.'
                  : 'No queries match your search.'}
              </div>
            )}
          </div>
        </section>
      )}

      {activeAdminTask === 'password_resets' && (
        <section className="support-panel password-reset-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Account Security</span>
              <h3>Reset Password Requests</h3>
            </div>
            <span className="support-note">
              {passwordResetRequests.filter((request) => request.status === 'Pending').length} pending
            </span>
          </div>
          {passwordResetMessage && (
            <div className="support-message" role="status">{passwordResetMessage}</div>
          )}
          <div className="query-list">
            {passwordResetRequests.map((request) => (
              <article className="query-card password-reset-card" key={request.id}>
                <div className="query-card-head">
                  <strong>
                    {request.employee_name} ({request.employee_emp_code})
                  </strong>
                  <span className={`query-status status-${request.status.toLowerCase()}`}>
                    {request.status}
                  </span>
                </div>
                <p>
                  Requested a new login password. The password remains inactive until approved.
                </p>
                <div className="query-meta">
                  <span>Requested {formatDateTime(request.created_at)}</span>
                  <span>Manager: {request.manager_name}</span>
                  {request.status === 'Pending' && (
                    <>
                      <button
                        type="button"
                        className="approve-reset-btn"
                        onClick={() => reviewPasswordReset(request.id, 'approve')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="reject-reset-btn"
                        onClick={() => reviewPasswordReset(request.id, 'reject')}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {request.reviewed_at && (
                    <span>
                      Reviewed {formatDateTime(request.reviewed_at)} by {request.reviewed_by}
                    </span>
                  )}
                </div>
              </article>
            ))}
            {passwordResetRequests.length === 0 && (
              <div className="empty-list">No password reset requests found.</div>
            )}
          </div>
        </section>
      )}

      {!activeAdminTask && (
        <div className="stats-row">
          <div className="stat-card"><div className="stat-icon si-present">P</div><div className="stat-num sn-present">{summary.present}</div><div className="stat-lbl">Present</div><div className="stat-bar sb-present" /></div>
          <div className="stat-card"><div className="stat-icon si-halfday">HD</div><div className="stat-num sn-halfday">{summary.halfDay}</div><div className="stat-lbl">Half Day</div><div className="stat-bar sb-halfday" /></div>
          <div className="stat-card"><div className="stat-icon si-absent">A</div><div className="stat-num sn-absent">{summary.absent}</div><div className="stat-lbl">Absent / Short</div><div className="stat-bar sb-absent" /></div>
        </div>
      )}

      {activeAdminTask === 'my_report' && (() => {
        const rows = buildMyReportRows();
        const workingRows = rows.filter((r) => r.label !== 'Holiday' && r.label !== 'Weekly Off' && r.label !== '—');
        const presentRows = rows.filter((r) => r.label === 'Present');
        const halfDayRows = rows.filter((r) => r.label === 'Half Day');
        const attendedRows = [...presentRows, ...halfDayRows];
        const onTimeRows = attendedRows.filter((r) => r.late === 'On Time');
        const lateRows = attendedRows.filter((r) => r.late === 'Late');
        const workingDays = workingRows.length;
        const adherencePct = workingDays ? ((attendedRows.length / workingDays) * 100).toFixed(1) : '0.0';
        const latePct = attendedRows.length ? ((lateRows.length / attendedRows.length) * 100).toFixed(1) : '0.0';

        return (
          <section className="my-report-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Personal Attendance Report</span>
                <h3>My Report — {employeeName}</h3>
              </div>
              <div className="my-report-month-wrap">
                <span className="month-lbl">Month</span>
                <input
                  type="month"
                  max={currentMonth}
                  value={selectedMonth}
                  className="month-input"
                  onChange={(e) => setSelectedMonth(e.target.value)}
                />
              </div>
            </div>

            <div className="my-report-kpis">
              <div className="my-kpi my-kpi-blue"><span>Working Days</span><strong>{workingDays}</strong></div>
              <div className="my-kpi my-kpi-green"><span>Present</span><strong>{presentRows.length}</strong></div>
              <div className="my-kpi my-kpi-amber"><span>Half Day</span><strong>{halfDayRows.length}</strong></div>
              <div className="my-kpi my-kpi-red"><span>Absent</span><strong>{workingRows.filter((r) => r.label === 'Absent').length}</strong></div>
              <div className="my-kpi my-kpi-teal"><span>On Time</span><strong>{onTimeRows.length}</strong></div>
              <div className="my-kpi my-kpi-orange"><span>Late</span><strong>{lateRows.length}</strong></div>
              <div className="my-kpi my-kpi-navy"><span>Adherence</span><strong>{adherencePct}%</strong></div>
              <div className="my-kpi my-kpi-rose"><span>Late %</span><strong>{latePct}%</strong></div>
            </div>

            <div className="my-report-shift-note">Shift: 9:30 AM – 6:30 PM &nbsp;|&nbsp; Late = Punch In after 9:30 AM &nbsp;|&nbsp; Adherence Met = 9+ hours login</div>

            <div className="my-report-table-wrap">
              <table className="my-report-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Punch In</th>
                    <th>Punch Out</th>
                    <th>Login Hrs</th>
                    <th>Status</th>
                    <th>Punctuality</th>
                    <th>Shift Adherence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.dateKey} className={row.cls}>
                      <td>{row.dateKey}</td>
                      <td>{row.dayName}</td>
                      <td>{row.punchIn || '—'}</td>
                      <td>{row.punchOut || '—'}</td>
                      <td>{row.loginHours || '—'}</td>
                      <td><span className={`mr-badge ${row.cls}`}>{row.label}</span></td>
                      <td>{row.late ? <span className={row.lateCls}>{row.late}</span> : '—'}</td>
                      <td>{row.adherence || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {activeAdminTask === 'reports' && (
        <ReportDashboard
          apiBaseUrl={API_BASE_URL}
          token={token}
          initialMonth={selectedMonth}
          isSuperAdmin={isSuperAdmin}
        />
      )}

      {activeAdminTask === 'roster' && (
        <RosterManagement
          apiBaseUrl={API_BASE_URL}
          token={token}
          initialMonth={selectedMonth}
          canManageShifts={isSuperAdmin}
        />
      )}

      {activeAdminTask === 'access' && (
        <ApplicationAccess
          apiBaseUrl={API_BASE_URL}
          token={token}
          currentEmpCode={employeeCode}
        />
      )}

      {activeAdminTask === 'managers' && (
        <section className="admin-panel manager-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">SuperAdmin Administration</span>
              <h3>{editingManagerId ? 'Edit Manager' : 'Add Manager'}</h3>
            </div>
            <span className="auto-id-note">ID: Auto generated</span>
          </div>
          <form onSubmit={saveManager} className="employee-form manager-form">
            <label>
              <span>Manager_empcode</span>
              <input
                type="text"
                value={newManager.manager_empcode}
                onChange={(event) => (
                  updateNewManager('manager_empcode', event.target.value.toUpperCase())
                )}
                required
              />
            </label>
            <label>
              <span>Manager_Name</span>
              <input
                type="text"
                value={newManager.manager_name}
                onChange={(event) => updateNewManager('manager_name', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Process_name</span>
              <input
                type="text"
                value={newManager.process_name}
                onChange={(event) => updateNewManager('process_name', event.target.value)}
                required
              />
            </label>
            <label>
              <span>managar_unique_code</span>
              <input
                type="text"
                value={newManager.manager_unique_code}
                onChange={(event) => (
                  updateNewManager('manager_unique_code', event.target.value.toUpperCase())
                )}
                required
              />
            </label>
            <button type="submit">{editingManagerId ? 'Update Manager' : 'Add Manager'}</button>
            {editingManagerId && (
              <button type="button" className="cancel-btn" onClick={cancelManagerEdit}>
                Cancel
              </button>
            )}
          </form>
          {managerFormMessage && (
            <div className="employee-form-message" role="status">{managerFormMessage}</div>
          )}
          <div className="manager-list">
            <div className="manager-list-head">
              <span>ID</span>
              <span>Manager Emp Code</span>
              <span>Manager Name</span>
              <span>Process</span>
              <span>Unique Code</span>
              <span>Employees</span>
              <span>Actions</span>
            </div>
            {managers.map((manager) => (
              <div className="manager-list-row" key={manager.id}>
                <span>{manager.id}</span>
                <strong>{manager.manager_empcode}</strong>
                <span>{manager.manager_name}</span>
                <span>{manager.process_name}</span>
                <span>{manager.manager_unique_code}</span>
                <span>{manager.assigned_employee_count || 0}</span>
                <div className="list-actions">
                  <button type="button" className="edit-btn" onClick={() => editManager(manager)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="assign-manager-btn"
                    onClick={() => openEmployeeAssignment(manager)}
                  >
                    Assign Employees
                  </button>
                  <button
                    type="button"
                    className="delete-manager-btn"
                    onClick={() => deleteManager(manager)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {managers.length === 0 && (
              <div className="empty-list">No managers found.</div>
            )}
          </div>
          {assignmentManager && (
            <section className="assignment-panel">
              <div className="panel-heading">
                <div>
                  <span className="panel-kicker">Employee Assignment</span>
                  <h3>{assignmentManager.manager_name}</h3>
                </div>
                <button
                  type="button"
                  className="assignment-close-btn"
                  onClick={closeEmployeeAssignment}
                >
                  Close
                </button>
              </div>
              <div className="assignment-manager-meta">
                <span>{assignmentManager.manager_empcode}</span>
                <span>{assignmentManager.process_name}</span>
                <span>{assignmentManager.manager_unique_code}</span>
              </div>
              {assignmentMessage && (
                <div className="employee-form-message" role="status">{assignmentMessage}</div>
              )}
              <div className="employee-search assignment-search">
                <label>
                  <span>Search by ID</span>
                  <input
                    type="search"
                    value={assignmentIdSearch}
                    onChange={(event) => setAssignmentIdSearch(event.target.value)}
                    placeholder="Employee ID or code"
                  />
                </label>
                <label>
                  <span>Search by Name</span>
                  <input
                    type="search"
                    value={assignmentNameSearch}
                    onChange={(event) => setAssignmentNameSearch(event.target.value)}
                    placeholder="Employee name"
                  />
                </label>
                <div className="assignment-search-actions">
                  <button
                    type="button"
                    className="assignment-search-btn"
                    onClick={() => searchAssignmentEmployees()}
                  >
                    Search
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAssignmentIdSearch('');
                      setAssignmentNameSearch('');
                      setAssignmentBulkCodes('');
                      setAssignmentGroupProcess('');
                      setAssignmentGroupValue('');
                      setAssignmentSearchResults([]);
                      setSelectedAvailableEmployeeIds([]);
                      setSelectedAssignedEmployeeIds([]);
                      fetchAssignedEmployees(assignmentManager.id);
                      fetchAvailableEmployees(assignmentManager.id);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="assignment-bulk-search">
                <label>
                  <span>Paste Employee Codes</span>
                  <textarea
                    value={assignmentBulkCodes}
                    onChange={(event) => setAssignmentBulkCodes(event.target.value.toUpperCase())}
                    placeholder="MAS10001, MAS10002, MAS10003"
                  />
                </label>
                <button type="button" onClick={searchAssignmentBulkCodes}>
                  Find EmpCodes
                </button>
                {assignmentBulkCodes && (
                  <button
                    type="button"
                    className="bulk-clear-btn"
                    onClick={() => {
                      setAssignmentBulkCodes('');
                      setAssignmentSearchResults([]);
                      setSelectedAvailableEmployeeIds([]);
                      fetchAvailableEmployees(assignmentManager.id);
                    }}
                  >
                    Clear Codes
                  </button>
                )}
              </div>
              <div className="assignment-group-search">
                <div className="assignment-group-heading">
                  <div>
                    <span className="panel-kicker">Assign Complete Group</span>
                    <strong>Assign by Process or LOB</strong>
                  </div>
                  <small>Matching employees will be selected automatically.</small>
                </div>
                <label>
                  <span>Group Type</span>
                  <select
                    value={assignmentGroupType}
                    onChange={(event) => {
                      setAssignmentGroupType(event.target.value);
                      setAssignmentGroupProcess('');
                      setAssignmentGroupValue('');
                    }}
                  >
                    <option value="process">Process</option>
                    <option value="lob">LOB</option>
                  </select>
                </label>
                <label>
                  <span>Process Name</span>
                  <select
                    value={assignmentGroupType === 'process'
                      ? assignmentGroupValue
                      : assignmentGroupProcess}
                    onChange={(event) => {
                      if (assignmentGroupType === 'process') {
                        setAssignmentGroupValue(event.target.value);
                      } else {
                        setAssignmentGroupProcess(event.target.value);
                        setAssignmentGroupValue('');
                      }
                    }}
                  >
                    <option value="">Select Process</option>
                    {agentProcessOptions.processes.map((option) => (
                      <option value={option} key={option}>{option}</option>
                    ))}
                  </select>
                </label>
                {assignmentGroupType === 'lob' && (
                  <label>
                    <span>LOB Name</span>
                    <select
                      value={assignmentGroupValue}
                      disabled={!assignmentGroupProcess}
                      onChange={(event) => setAssignmentGroupValue(event.target.value)}
                    >
                      <option value="">
                        {assignmentGroupProcess ? 'Select LOB' : 'Select Process first'}
                      </option>
                      {(agentProcessOptions.lobsByProcess[assignmentGroupProcess] || [])
                        .map((option) => (
                          <option value={option} key={option}>{option}</option>
                        ))}
                    </select>
                  </label>
                )}
                <button type="button" onClick={searchAssignmentGroup}>
                  Load & Select Whole Group
                </button>
                {(assignmentGroupProcess || assignmentGroupValue) && (
                  <button
                    type="button"
                    className="group-clear-btn"
                    onClick={() => {
                      setAssignmentGroupProcess('');
                      setAssignmentGroupValue('');
                      setAssignmentSearchResults([]);
                      setSelectedAvailableEmployeeIds([]);
                      fetchAvailableEmployees(assignmentManager.id);
                    }}
                  >
                    Clear Group
                  </button>
                )}
              </div>
              <div className="assignment-columns">
                <div className="assignment-column">
                  <div className="assignment-column-head">
                    <div>
                      <span className="panel-kicker">Available Employees</span>
                      <strong>{availableAssignmentEmployees.length} found</strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedAvailableEmployeeIds(
                        availableAssignmentEmployees.map((employee) => employee.id)
                      )}
                    >
                      Select All
                    </button>
                  </div>
                  <div className="assignment-list">
                    {availableAssignmentEmployees.map((employee) => (
                      <label className="assignment-row" key={employee.id}>
                        <input
                          type="checkbox"
                          checked={selectedAvailableEmployeeIds.includes(employee.id)}
                          onChange={() => toggleEmployeeSelection(employee.id, false)}
                        />
                        <span>
                          <strong>{employee.emp_name}</strong>
                          <small>
                            {employee.emp_code} | {employee.designation}
                            {employee.process_name ? ` | ${employee.process_name}` : ''}
                            {employee.lob_name ? ` | ${employee.lob_name}` : ''}
                            {employee.assigned_manager_name
                              ? ` | Current: ${employee.assigned_manager_name}`
                              : ' | Unassigned'}
                          </small>
                        </span>
                      </label>
                    ))}
                    {availableAssignmentEmployees.length === 0 && (
                      <div className="empty-list">No available employees found.</div>
                    )}
                  </div>
                  {assignmentHasMore && (
                    <button
                      type="button"
                      className="assignment-load-more-btn"
                      onClick={() => fetchAvailableEmployees(
                        assignmentManager.id,
                        assignmentIdSearch,
                        assignmentNameSearch,
                        assignmentAvailableOffset,
                        true,
                        assignmentBulkCodes,
                        assignmentGroupType,
                        assignmentGroupValue,
                        assignmentGroupProcess
                      )}
                    >
                      Load More Employees
                    </button>
                  )}
                  <button
                    type="button"
                    className="assignment-primary-btn"
                    disabled={selectedAvailableEmployeeIds.length === 0}
                    onClick={() => updateEmployeeAssignments('assign')}
                  >
                    Assign Selected ({selectedAvailableEmployeeIds.length})
                  </button>
                </div>
                <div className="assignment-column">
                  <div className="assignment-column-head">
                    <div>
                      <span className="panel-kicker">Currently Assigned</span>
                      <strong>
                        Showing {assignedEmployees.length} of {Math.max(
                          assignedEmployees.length,
                          assignmentManager.assigned_employee_count || 0
                        )}
                      </strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedAssignedEmployeeIds(
                        assignedEmployees.map((employee) => employee.id)
                      )}
                    >
                      Select All
                    </button>
                  </div>
                  <div className="assignment-list">
                    {assignedEmployees.map((employee) => (
                      <label className="assignment-row" key={employee.id}>
                        <input
                          type="checkbox"
                          checked={selectedAssignedEmployeeIds.includes(employee.id)}
                          onChange={() => toggleEmployeeSelection(employee.id, true)}
                        />
                        <span>
                          <strong>{employee.emp_name}</strong>
                          <small>{employee.emp_code} | {employee.designation}</small>
                        </span>
                      </label>
                    ))}
                    {assignedEmployees.length === 0 && (
                      <div className="empty-list">No employees assigned yet.</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="assignment-remove-btn"
                    disabled={selectedAssignedEmployeeIds.length === 0}
                    onClick={() => updateEmployeeAssignments('remove')}
                  >
                    Remove Selected ({selectedAssignedEmployeeIds.length})
                  </button>
                </div>
              </div>
            </section>
          )}
        </section>
      )}

      {(showHolidayPanel || activeAdminTask === 'holidays') && (
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

      {(showEmployeePanel || activeAdminTask === 'employees') && (
        <section className="admin-panel employee-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Administration</span>
              <h3>{editingEmployeeId ? 'Edit Employee' : 'Add Employee'}</h3>
            </div>
            <div className="panel-heading-actions">
              <span className="auto-id-note">ID: Auto generated</span>
              {!editingEmployeeId && (
                <button
                  type="button"
                  className="bulk-employee-toggle"
                  aria-expanded={bulkEmployeeOpen}
                  onClick={() => {
                    setBulkEmployeeOpen((open) => !open);
                    setBulkEmployeeMessage('');
                  }}
                >
                  {bulkEmployeeOpen ? 'Hide Bulk Add' : 'Add Bulk Employees'}
                </button>
              )}
            </div>
          </div>
          <form onSubmit={saveEmployee} className="employee-form">
            <label>
              <span>Employee Code</span>
              <input
                type="text"
                value={newEmployee.emp_code}
                onChange={(event) => updateNewEmployee('emp_code', event.target.value.toUpperCase())}
                required
              />
            </label>
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
                placeholder="Executive"
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
              <span>Process</span>
              <input
                type="text"
                value={newEmployee.process_name}
                onChange={(event) => updateNewEmployee('process_name', event.target.value)}
                required
              />
            </label>
            <label>
              <span>LOBName</span>
              <input
                type="text"
                value={newEmployee.lob_name}
                onChange={(event) => updateNewEmployee('lob_name', event.target.value)}
                required
              />
            </label>
            <label>
              <span>Application Access</span>
              <select
                value={newEmployee.status}
                onChange={(event) => updateNewEmployee('status', event.target.value)}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </label>
            <button type="submit">{editingEmployeeId ? 'Update Employee' : 'Add Employee'}</button>
            {editingEmployeeId && (
              <button type="button" className="cancel-btn" onClick={cancelEmployeeEdit}>Cancel</button>
            )}
          </form>
          {employeeFormMessage && (
            <div className="employee-form-message" role="status">{employeeFormMessage}</div>
          )}
          {bulkEmployeeOpen && (
            <div className="bulk-employee-panel">
              <div className="bulk-employee-head">
                <div>
                  <span className="panel-kicker">Paste From Excel or CSV</span>
                  <strong>One employee per line, in the sequence shown below</strong>
                </div>
                <small>Maximum 500 employees per batch</small>
              </div>
              <code>
                Employee Code, Employee Name, Designation, Role, Process, LOBName, Application Access
              </code>
              <label>
                <span>Bulk Employee Rows</span>
                <textarea
                  value={bulkEmployeeText}
                  onChange={(event) => setBulkEmployeeText(event.target.value)}
                  placeholder={'MAS10001, Riya Sharma, Executive, Employee, Sales, Inbound, Active\nMAS10002, Aman Verma, Executive, Employee, Sales, Chat, Active'}
                />
              </label>
              <div className="bulk-employee-actions">
                <button type="button" onClick={saveBulkEmployees}>Add Bulk Employees</button>
                <button
                  type="button"
                  className="bulk-clear-btn"
                  onClick={() => {
                    setBulkEmployeeText('');
                    setBulkEmployeeMessage('');
                  }}
                >
                  Clear
                </button>
              </div>
              {bulkEmployeeMessage && (
                <div className="employee-form-message" role="status">{bulkEmployeeMessage}</div>
              )}
            </div>
          )}
          <div className="employee-search">
            <label>
              <span>Search by ID</span>
              <input
                type="search"
                value={employeeIdSearch}
                onChange={(event) => {
                  setEmployeeIdSearch(event.target.value);
                  setEmployeeSearchActive(false);
                }}
                placeholder="Employee ID or code"
              />
            </label>
            <label>
              <span>Search by Name</span>
              <input
                type="search"
                value={employeeNameSearch}
                onChange={(event) => {
                  setEmployeeNameSearch(event.target.value);
                  setEmployeeSearchActive(false);
                }}
                placeholder="Employee name"
              />
            </label>
            <button type="button" className="employee-search-submit" onClick={searchEmployees}>
              Search
            </button>
            {(employeeIdSearch || employeeNameSearch) && (
              <button
                type="button"
                onClick={() => {
                  setEmployeeIdSearch('');
                  setEmployeeNameSearch('');
                  setEmployeeSearchActive(false);
                  setEmployees([]);
                }}
              >
                Clear Search
              </button>
            )}
          </div>
          {hasEmployeeSearch && (
            <div className="employee-list">
              <div className="employee-list-head">
                <span>ID</span>
                <span>Emp Code</span>
                <span>Employee</span>
                <span>Designation</span>
                <span>Role</span>
                <span>Process</span>
                <span>LOBName</span>
                <span>App Access</span>
                <span>Action</span>
              </div>
              {filteredEmployees.map((employee) => (
                <div className="employee-list-row" key={employee.id}>
                  <span>{employee.id}</span>
                  <span>{employee.emp_code}</span>
                  <strong>{employee.emp_name}</strong>
                  <span>{employee.designation}</span>
                  <span>{employee.role}</span>
                  <span>{employee.process_name || '-'}</span>
                  <span>{employee.lob_name || '-'}</span>
                  <span className={`employee-status ${String(employee.status).toLowerCase()}`}>
                    {employee.status || '-'}
                  </span>
                  <button type="button" className="edit-btn" onClick={() => editEmployee(employee)}>
                    Edit
                  </button>
                </div>
              ))}
              {filteredEmployees.length === 0 && (
                <div className="empty-list">
                  {employees.length === 0 ? 'No employees found.' : 'No employees match your search.'}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {isSuperAdmin && !activeAdminTask && !loading && attendance.length > 0 && (
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

      {!activeAdminTask && loading && <div className="loader">Loading...</div>}
      {!activeAdminTask && error && <div className="dash-error">{error}</div>}
      {!activeAdminTask && !loading && (
        <div className="cal-card">
          <Calendar
            activeStartDate={new Date(year, month - 1, 1)}
            calendarType="gregory"
            locale="en-US"
            maxDate={today}
            maxDetail="month"
            minDetail="year"
            showNeighboringMonth={false}
            tileClassName={getCalendarTileClassName}
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
            <span className="legend-item"><i className="ldot ld-halfday" /> Half Day (4-9h)</span>
            <span className="legend-item"><i className="ldot ld-absent" /> Absent/Short (&lt;4h)</span>
            <span className="legend-item"><i className="ldot ld-holiday" /> Holiday</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
