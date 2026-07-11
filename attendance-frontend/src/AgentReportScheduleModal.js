import React, { useCallback, useEffect, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const parseEmails = (raw) => raw.split(',').map((part) => part.trim()).filter(Boolean);

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const emptyForm = {
  process_name: '', lob_name: '', attendance: 'present', frequency: 'daily',
  report_day: 'yesterday', run_date: todayKey(), send_time: '09:00', email: ''
};

function AgentReportScheduleModal({ apiBaseUrl, token, agentProcessOptions, onClose }) {
  const [schedules, setSchedules] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [scheduleRes, contactRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/agent-report/schedules`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${apiBaseUrl}/api/process-contacts`, { headers: { Authorization: `Bearer ${token}` } })
      ]);
      const scheduleData = await scheduleRes.json().catch(() => ([]));
      const contactData = await contactRes.json().catch(() => ([]));
      if (!scheduleRes.ok) throw new Error(scheduleData.detail || 'Failed to load schedules');
      setSchedules(Array.isArray(scheduleData) ? scheduleData : []);
      setContacts(Array.isArray(contactData) ? contactData : []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const lobOptionsForForm = form.process_name
    ? (agentProcessOptions.lobsByProcess[form.process_name] || [])
    : (agentProcessOptions.lobs || []);

  const updateForm = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'process_name') {
        next.lob_name = '';
        const matchedContact = contacts.find((contact) => contact.process_name === value);
        if (matchedContact && !current.email) next.email = matchedContact.email;
      }
      return next;
    });
  };

  const submitForm = async (event) => {
    event.preventDefault();
    const emails = parseEmails(form.email);
    if (!emails.length || emails.some((email) => !EMAIL_RE.test(email))) {
      setFormError('Enter one or more valid, comma-separated email addresses');
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/agent-report/schedules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          process_name: form.process_name,
          lob_name: form.lob_name || null,
          attendance: form.attendance,
          frequency: form.frequency,
          report_day: form.report_day,
          run_date: form.frequency === 'once' ? form.run_date : null,
          send_time: form.send_time,
          email: emails.join(', '),
          status: 'Active'
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to create schedule');
      setFormMessage('Schedule created');
      setForm(emptyForm);
      fetchAll();
    } catch (requestError) {
      setFormError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (schedule) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/agent-report/schedules/${schedule.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          process_name: schedule.process_name,
          lob_name: schedule.lob_name,
          attendance: schedule.attendance,
          frequency: schedule.frequency,
          report_day: schedule.report_day,
          run_date: schedule.run_date,
          send_time: schedule.send_time,
          email: schedule.email,
          status: schedule.status === 'Active' ? 'Paused' : 'Active'
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to update schedule');
      }
      fetchAll();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const deleteSchedule = async (scheduleId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/agent-report/schedules/${scheduleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to delete schedule');
      }
      fetchAll();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card modal-card-wide">
        <h3>Schedule Report</h3>
        <p className="modal-subtitle">
          Auto-sends the Agent Report — every day at a chosen time, or once on a specific date.
        </p>

        {loading && <div className="report-loading">Loading schedules...</div>}
        {error && <div className="report-error" role="alert">{error}</div>}

        {!loading && !error && (
          <div className="agent-report-table-wrap">
            <table className="agent-report-table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>LOB</th>
                  <th>Attendance</th>
                  <th>Schedule</th>
                  <th>Time</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Last Sent</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.process_name}</td>
                    <td>{schedule.lob_name || 'All'}</td>
                    <td>{schedule.attendance}</td>
                    <td>
                      {schedule.frequency === 'once'
                        ? `Once on ${schedule.run_date}`
                        : `Every day (${schedule.report_day})`}
                    </td>
                    <td>{schedule.send_time}</td>
                    <td>{schedule.email}</td>
                    <td>
                      <span
                        className={`query-status ${
                          schedule.status === 'Active'
                            ? 'status-open'
                            : schedule.status === 'Completed' ? 'status-completed' : 'status-solved'
                        }`}
                      >
                        {schedule.status}
                      </span>
                    </td>
                    <td>
                      {schedule.last_sent_at
                        ? `${schedule.last_sent_at.slice(0, 16).replace('T', ' ')} (${schedule.last_sent_status})`
                        : 'Never'}
                    </td>
                    <td className="modal-table-actions">
                      {schedule.status !== 'Completed' && (
                        <button type="button" onClick={() => toggleStatus(schedule)}>
                          {schedule.status === 'Active' ? 'Pause' : 'Resume'}
                        </button>
                      )}
                      <button type="button" className="cancel-btn" onClick={() => deleteSchedule(schedule.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {!schedules.length && (
                  <tr>
                    <td colSpan={9} className="agent-report-empty">No schedules yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={submitForm} className="modal-form modal-form-inline">
          <label>
            <span>Process</span>
            <select
              value={form.process_name}
              onChange={(event) => updateForm('process_name', event.target.value)}
              required
            >
              <option value="">Select Process</option>
              {agentProcessOptions.processes.map((option) => (
                <option value={option} key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>LOB</span>
            <select value={form.lob_name} onChange={(event) => updateForm('lob_name', event.target.value)}>
              <option value="">All LOBs</option>
              {lobOptionsForForm.map((option) => (
                <option value={option} key={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Attendance</span>
            <select value={form.attendance} onChange={(event) => updateForm('attendance', event.target.value)}>
              <option value="present">Present</option>
              <option value="absent">Absent</option>
              <option value="all">All</option>
            </select>
          </label>
          <label>
            <span>Frequency</span>
            <select value={form.frequency} onChange={(event) => updateForm('frequency', event.target.value)}>
              <option value="daily">Every Day</option>
              <option value="once">One Time</option>
            </select>
          </label>
          {form.frequency === 'daily' ? (
            <label>
              <span>Report Day</span>
              <select value={form.report_day} onChange={(event) => updateForm('report_day', event.target.value)}>
                <option value="yesterday">Yesterday</option>
                <option value="today">Today</option>
              </select>
            </label>
          ) : (
            <label>
              <span>Date</span>
              <input
                type="date"
                min={todayKey()}
                value={form.run_date}
                onChange={(event) => updateForm('run_date', event.target.value)}
                required
              />
            </label>
          )}
          <label>
            <span>Send Time</span>
            <input
              type="time"
              value={form.send_time}
              onChange={(event) => updateForm('send_time', event.target.value)}
              required
            />
          </label>
          <label>
            <span>Email(s)</span>
            <input
              type="text"
              placeholder="a@company.com, b@company.com"
              value={form.email}
              onChange={(event) => updateForm('email', event.target.value)}
              required
            />
          </label>
          {formError && <div className="report-error" role="alert">{formError}</div>}
          {formMessage && <div className="modal-success" role="status">{formMessage}</div>}
          <div className="modal-actions">
            <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create Schedule'}</button>
          </div>
        </form>

        <div className="modal-actions">
          <button type="button" className="cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default AgentReportScheduleModal;
