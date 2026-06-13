import React, { useCallback, useEffect, useMemo, useState } from 'react';

const localDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

const parseEmployeeCodes = (value) => (
  [...new Set(
    value
      .split(/[\s,;]+/)
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
  )]
);

const formatShiftTime = (shift) => (
  `${shift.start_time} - ${shift.end_time}`
);

const weekdays = [
  { value: 0, label: 'Mon' },
  { value: 1, label: 'Tue' },
  { value: 2, label: 'Wed' },
  { value: 3, label: 'Thu' },
  { value: 4, label: 'Fri' },
  { value: 5, label: 'Sat' },
  { value: 6, label: 'Sun' }
];

function RosterManagement({
  apiBaseUrl,
  token,
  initialMonth,
  canManageShifts
}) {
  const today = new Date();
  const todayKey = localDateKey(today);
  const monthStart = `${initialMonth}-01`;
  const monthEnd = localDateKey(new Date(
    Number(initialMonth.slice(0, 4)),
    Number(initialMonth.slice(5, 7)),
    0
  ));
  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [rosterEntries, setRosterEntries] = useState([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [rosterSearch, setRosterSearch] = useState('');
  const [selectedEmployeeCodes, setSelectedEmployeeCodes] = useState('');
  const [rosterDates, setRosterDates] = useState({
    date_from: monthStart,
    date_to: monthEnd
  });
  const [assignment, setAssignment] = useState({
    date_from: todayKey,
    date_to: todayKey,
    day_type: 'Working',
    shift_id: '',
    weekdays: [0, 1, 2, 3, 4, 5]
  });
  const [shiftForm, setShiftForm] = useState({
    shift_name: '',
    start_time: '09:00',
    end_time: '19:00',
    grace_minutes: 15,
    break_minutes: 60,
    status: 'Active'
  });
  const [editingShiftId, setEditingShiftId] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const authHeaders = useMemo(() => ({
    Authorization: `Bearer ${token}`
  }), [token]);

  const fetchShifts = useCallback(async () => {
    const response = await fetch(`${apiBaseUrl}/api/roster/shifts`, {
      headers: authHeaders
    });
    const data = await response.json().catch(() => ([]));
    if (!response.ok) throw new Error(data.detail || 'Failed to load shifts');
    setShifts(Array.isArray(data) ? data : []);
    setAssignment((current) => {
      if (current.shift_id) return current;
      const firstActiveShift = data.find((shift) => shift.status === 'Active');
      return {
        ...current,
        shift_id: firstActiveShift ? String(firstActiveShift.id) : ''
      };
    });
  }, [apiBaseUrl, authHeaders]);

  const fetchEmployees = useCallback(async (searchValue = '') => {
    const params = new URLSearchParams({ limit: '100' });
    if (searchValue.trim()) params.set('search', searchValue.trim());
    const response = await fetch(`${apiBaseUrl}/api/roster/employees?${params}`, {
      headers: authHeaders
    });
    const data = await response.json().catch(() => ([]));
    if (!response.ok) throw new Error(data.detail || 'Failed to load employees');
    setEmployees(Array.isArray(data) ? data : []);
  }, [apiBaseUrl, authHeaders]);

  const fetchRoster = useCallback(async (searchValue = '') => {
    const params = new URLSearchParams(rosterDates);
    params.set('limit', '500');
    if (searchValue.trim()) params.set('search', searchValue.trim());
    const response = await fetch(`${apiBaseUrl}/api/roster?${params}`, {
      headers: authHeaders
    });
    const data = await response.json().catch(() => ([]));
    if (!response.ok) throw new Error(data.detail || 'Failed to load roster');
    setRosterEntries(Array.isArray(data) ? data : []);
  }, [apiBaseUrl, authHeaders, rosterDates]);

  useEffect(() => {
    let active = true;
    const loadPage = async () => {
      setLoading(true);
      setError('');
      try {
        await Promise.all([fetchShifts(), fetchEmployees(), fetchRoster('')]);
      } catch (requestError) {
        if (active) setError(requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadPage();
    return () => { active = false; };
  }, [fetchEmployees, fetchRoster, fetchShifts]);

  const updateAssignment = (field, value) => {
    setAssignment((current) => ({ ...current, [field]: value }));
  };

  const toggleWeekday = (weekday) => {
    setAssignment((current) => ({
      ...current,
      weekdays: current.weekdays.includes(weekday)
        ? current.weekdays.filter((day) => day !== weekday)
        : [...current.weekdays, weekday].sort()
    }));
  };

  const toggleEmployee = (empCode) => {
    const currentCodes = parseEmployeeCodes(selectedEmployeeCodes);
    const nextCodes = currentCodes.includes(empCode)
      ? currentCodes.filter((code) => code !== empCode)
      : [...currentCodes, empCode];
    setSelectedEmployeeCodes(nextCodes.join(', '));
  };

  const assignRoster = async (event) => {
    event.preventDefault();
    const empCodes = parseEmployeeCodes(selectedEmployeeCodes);
    if (empCodes.length === 0) {
      setError('Enter or select at least one employee code.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/roster/assign`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          emp_codes: empCodes,
          date_from: assignment.date_from,
          date_to: assignment.date_to,
          day_type: assignment.day_type,
          shift_id: assignment.day_type === 'Working'
            ? Number(assignment.shift_id)
            : null,
          weekdays: assignment.weekdays
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to assign roster');
      setMessage(
        `${data.employee_count} employee(s) rostered across ${data.roster_dates} date(s). `
        + `${data.created_count} created, ${data.updated_count} updated.`
      );
      await fetchRoster('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const saveShift = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        editingShiftId
          ? `${apiBaseUrl}/api/roster/shifts/${editingShiftId}`
          : `${apiBaseUrl}/api/roster/shifts`,
        {
          method: editingShiftId ? 'PUT' : 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ...shiftForm,
            grace_minutes: Number(shiftForm.grace_minutes),
            break_minutes: Number(shiftForm.break_minutes)
          })
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to save shift');
      setMessage(`Shift ${data.shift_name} saved successfully.`);
      setEditingShiftId(null);
      setShiftForm({
        shift_name: '',
        start_time: '09:00',
        end_time: '19:00',
        grace_minutes: 15,
        break_minutes: 60,
        status: 'Active'
      });
      await fetchShifts();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const editShift = (shift) => {
    setEditingShiftId(shift.id);
    setShiftForm({
      shift_name: shift.shift_name,
      start_time: shift.start_time,
      end_time: shift.end_time,
      grace_minutes: shift.grace_minutes,
      break_minutes: shift.break_minutes,
      status: shift.status
    });
    setError('');
    setMessage('');
  };

  const cancelShiftEdit = () => {
    setEditingShiftId(null);
    setShiftForm({
      shift_name: '',
      start_time: '09:00',
      end_time: '19:00',
      grace_minutes: 15,
      break_minutes: 60,
      status: 'Active'
    });
  };

  const deleteShift = async (shift) => {
    if (!window.confirm(`Delete shift ${shift.shift_name}?`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/roster/shifts/${shift.id}`, {
        method: 'DELETE',
        headers: authHeaders
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to delete shift');
      setMessage(`Shift ${shift.shift_name} deleted.`);
      await fetchShifts();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const deleteRosterEntry = async (entry) => {
    if (!window.confirm(`Remove ${entry.name}'s roster for ${entry.roster_date}?`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/roster/${entry.id}`, {
        method: 'DELETE',
        headers: authHeaders
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to remove roster');
      setMessage('Roster entry removed.');
      await fetchRoster(rosterSearch);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const activeShiftCount = shifts.filter((shift) => shift.status === 'Active').length;
  const rosteredAgentCount = new Set(rosterEntries.map((entry) => entry.emp_code)).size;

  return (
    <section className="roster-page" aria-label="Roster management">
      <div className="roster-hero">
        <div>
          <span>Workforce Planning</span>
          <h2>Roster & Shift Planner</h2>
          <p>Create shifts such as 09:00–19:00 and assign working or non-working days.</p>
        </div>
        <div className="roster-hero-stats">
          <div><strong>{activeShiftCount}</strong><span>Active Shifts</span></div>
          <div><strong>{rosteredAgentCount}</strong><span>Rostered Agents</span></div>
          <div><strong>{rosterEntries.length}</strong><span>Entries Shown</span></div>
        </div>
      </div>

      {error && <div className="roster-alert roster-alert-error" role="alert">{error}</div>}
      {message && <div className="roster-alert roster-alert-success" role="status">{message}</div>}
      {loading && <div className="roster-loading">Loading roster workspace...</div>}

      {!loading && (
        <>
          {canManageShifts && (
            <section className="roster-section">
              <div className="roster-section-heading">
                <div>
                  <span>Step 1</span>
                  <h3>{editingShiftId ? 'Edit Shift' : 'Create Shift'}</h3>
                </div>
                <small>Break time is removed from expected productive minutes.</small>
              </div>
              <form className="shift-form" onSubmit={saveShift}>
                <label>
                  <span>Shift Name</span>
                  <input
                    value={shiftForm.shift_name}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      shift_name: event.target.value
                    }))}
                    placeholder="General 9-7"
                    required
                  />
                </label>
                <label>
                  <span>Start Time</span>
                  <input
                    type="time"
                    value={shiftForm.start_time}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      start_time: event.target.value
                    }))}
                    required
                  />
                </label>
                <label>
                  <span>End Time</span>
                  <input
                    type="time"
                    value={shiftForm.end_time}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      end_time: event.target.value
                    }))}
                    required
                  />
                </label>
                <label>
                  <span>Grace Minutes</span>
                  <input
                    type="number"
                    min="0"
                    max="180"
                    value={shiftForm.grace_minutes}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      grace_minutes: event.target.value
                    }))}
                    required
                  />
                </label>
                <label>
                  <span>Break Minutes</span>
                  <input
                    type="number"
                    min="0"
                    value={shiftForm.break_minutes}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      break_minutes: event.target.value
                    }))}
                    required
                  />
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={shiftForm.status}
                    onChange={(event) => setShiftForm((current) => ({
                      ...current,
                      status: event.target.value
                    }))}
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </label>
                <button type="submit" disabled={saving}>
                  {editingShiftId ? 'Update Shift' : 'Create Shift'}
                </button>
                {editingShiftId && (
                  <button type="button" className="roster-secondary-btn" onClick={cancelShiftEdit}>
                    Cancel
                  </button>
                )}
              </form>

              <div className="shift-card-grid">
                {shifts.map((shift) => (
                  <article className={`shift-card ${shift.status.toLowerCase()}`} key={shift.id}>
                    <div>
                      <span>{shift.status}</span>
                      <strong>{shift.shift_name}</strong>
                      <b>{formatShiftTime(shift)}</b>
                    </div>
                    <dl>
                      <div><dt>Grace</dt><dd>{shift.grace_minutes} min</dd></div>
                      <div><dt>Break</dt><dd>{shift.break_minutes} min</dd></div>
                      <div><dt>Productive</dt><dd>{Math.floor(shift.productive_minutes / 60)}h {shift.productive_minutes % 60}m</dd></div>
                    </dl>
                    <div className="shift-card-actions">
                      <button type="button" onClick={() => editShift(shift)}>Edit</button>
                      <button type="button" onClick={() => deleteShift(shift)}>Delete</button>
                    </div>
                  </article>
                ))}
                {shifts.length === 0 && (
                  <div className="roster-empty">Create your first shift to start assigning Working days.</div>
                )}
              </div>
            </section>
          )}

          <section className="roster-section">
            <div className="roster-section-heading">
              <div>
                <span>{canManageShifts ? 'Step 2' : 'Roster Assignment'}</span>
                <h3>Assign Employee Roster</h3>
              </div>
              <small>Existing entries on the same employee and date will be updated.</small>
            </div>

            <div className="roster-assignment-layout">
              <div className="roster-employee-picker">
                <div className="roster-search-row">
                  <input
                    type="search"
                    aria-label="Search roster employees"
                    placeholder="Search name or employee code"
                    value={employeeSearch}
                    onChange={(event) => setEmployeeSearch(event.target.value)}
                  />
                  <button type="button" onClick={() => fetchEmployees(employeeSearch)}>Search</button>
                </div>
                <div className="roster-employee-list">
                  {employees.map((employee) => {
                    const selected = parseEmployeeCodes(selectedEmployeeCodes)
                      .includes(employee.emp_code);
                    return (
                      <label key={employee.emp_code}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleEmployee(employee.emp_code)}
                        />
                        <span>
                          <strong>{employee.name}</strong>
                          <small>
                            {employee.emp_code} | {employee.process_name} | {employee.lob_name}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                  {employees.length === 0 && (
                    <div className="roster-empty">No accessible employees found.</div>
                  )}
                </div>
              </div>

              <form className="roster-assignment-form" onSubmit={assignRoster}>
                <label className="roster-code-field">
                  <span>Employee Codes</span>
                  <textarea
                    aria-label="Employee Codes"
                    value={selectedEmployeeCodes}
                    onChange={(event) => setSelectedEmployeeCodes(event.target.value.toUpperCase())}
                    placeholder={'MAS10001, MAS10002\nMAS10003'}
                    required
                  />
                  <small>Paste up to 500 codes, separated by comma, space, or new line.</small>
                </label>
                <label>
                  <span>From Date</span>
                  <input
                    type="date"
                    value={assignment.date_from}
                    onChange={(event) => updateAssignment('date_from', event.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>To Date</span>
                  <input
                    type="date"
                    min={assignment.date_from}
                    value={assignment.date_to}
                    onChange={(event) => updateAssignment('date_to', event.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Day Type</span>
                  <select
                    value={assignment.day_type}
                    onChange={(event) => updateAssignment('day_type', event.target.value)}
                  >
                    <option value="Working">Working</option>
                    <option value="WeeklyOff">Weekly Off</option>
                    <option value="Leave">Leave</option>
                    <option value="Holiday">Holiday</option>
                  </select>
                </label>
                <label>
                  <span>Shift</span>
                  <select
                    value={assignment.shift_id}
                    disabled={assignment.day_type !== 'Working'}
                    onChange={(event) => updateAssignment('shift_id', event.target.value)}
                    required={assignment.day_type === 'Working'}
                  >
                    <option value="">Select Shift</option>
                    {shifts.filter((shift) => shift.status === 'Active').map((shift) => (
                      <option value={shift.id} key={shift.id}>
                        {shift.shift_name} ({formatShiftTime(shift)})
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="roster-weekdays">
                  <legend>Apply On</legend>
                  {weekdays.map((day) => (
                    <label key={day.value}>
                      <input
                        type="checkbox"
                        checked={assignment.weekdays.includes(day.value)}
                        onChange={() => toggleWeekday(day.value)}
                      />
                      <span>{day.label}</span>
                    </label>
                  ))}
                </fieldset>
                <button type="submit" className="roster-primary-btn" disabled={saving}>
                  {saving ? 'Saving Roster...' : 'Assign Roster'}
                </button>
              </form>
            </div>
          </section>

          <section className="roster-section">
            <div className="roster-section-heading">
              <div>
                <span>Calendar Records</span>
                <h3>View Assigned Roster</h3>
              </div>
              <small>Showing a maximum of 500 entries.</small>
            </div>
            <div className="roster-filter-row">
              <label>
                <span>From</span>
                <input
                  type="date"
                  value={rosterDates.date_from}
                  onChange={(event) => setRosterDates((current) => ({
                    ...current,
                    date_from: event.target.value
                  }))}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="date"
                  min={rosterDates.date_from}
                  value={rosterDates.date_to}
                  onChange={(event) => setRosterDates((current) => ({
                    ...current,
                    date_to: event.target.value
                  }))}
                />
              </label>
              <label>
                <span>Employee</span>
                <input
                  type="search"
                  value={rosterSearch}
                  onChange={(event) => setRosterSearch(event.target.value)}
                  placeholder="Name or code"
                />
              </label>
              <button type="button" onClick={() => fetchRoster(rosterSearch)}>Load Roster</button>
            </div>
            <div className="roster-table-scroll">
              <table className="roster-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Employee</th>
                    <th>Process / LOB</th>
                    <th>Day Type</th>
                    <th>Shift</th>
                    <th>Manager</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rosterEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.roster_date}</td>
                      <td><strong>{entry.name}</strong><span>{entry.emp_code}</span></td>
                      <td><strong>{entry.process_name}</strong><span>{entry.lob_name}</span></td>
                      <td><b className={`roster-day-type ${entry.day_type.toLowerCase()}`}>{entry.day_type}</b></td>
                      <td>
                        {entry.shift_name
                          ? <><strong>{entry.shift_name}</strong><span>{entry.start_time} - {entry.end_time}</span></>
                          : '-'}
                      </td>
                      <td>{entry.manager_name || 'Unassigned'}</td>
                      <td>
                        <button type="button" onClick={() => deleteRosterEntry(entry)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rosterEntries.length === 0 && (
                <div className="roster-empty">No roster entries found for this period.</div>
              )}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

export default RosterManagement;
