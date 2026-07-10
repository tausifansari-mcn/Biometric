import React, { useCallback, useEffect, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function AgentReport({ apiBaseUrl, token, agentProcessOptions }) {
  const [filters, setFilters] = useState({ date: todayKey(), process_name: '', lob_name: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [emailOpen, setEmailOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({ date: todayKey(), process_name: '', lob_name: '', email: '' });
  const [emailStatus, setEmailStatus] = useState({ loading: false, message: '', error: '' });

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ date: appliedFilters.date });
      if (appliedFilters.process_name) params.set('process_name', appliedFilters.process_name);
      if (appliedFilters.lob_name) params.set('lob_name', appliedFilters.lob_name);
      const response = await fetch(`${apiBaseUrl}/api/reports/agent-report?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to load agent report');
      setReport(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, appliedFilters, token]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const updateFilter = (field, value) => {
    setFilters((current) => {
      const next = { ...current, [field]: value };
      if (field === 'process_name') next.lob_name = '';
      return next;
    });
  };

  const submitFilters = (event) => {
    event.preventDefault();
    setAppliedFilters(filters);
  };

  const openEmailModal = () => {
    setEmailForm({
      date: appliedFilters.date,
      process_name: appliedFilters.process_name,
      lob_name: appliedFilters.lob_name,
      email: ''
    });
    setEmailStatus({ loading: false, message: '', error: '' });
    setEmailOpen(true);
  };

  const updateEmailField = (field, value) => {
    setEmailForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'process_name') next.lob_name = '';
      return next;
    });
  };

  const submitEmail = async (event) => {
    event.preventDefault();
    if (!EMAIL_RE.test(emailForm.email.trim())) {
      setEmailStatus({ loading: false, message: '', error: 'Enter a valid email address' });
      return;
    }
    setEmailStatus({ loading: true, message: '', error: '' });
    try {
      const response = await fetch(`${apiBaseUrl}/api/reports/agent-report/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          date: emailForm.date,
          process_name: emailForm.process_name || null,
          lob_name: emailForm.lob_name || null,
          email: emailForm.email.trim()
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to send report');
      setEmailStatus({ loading: false, message: `Report sent to ${data.email}`, error: '' });
    } catch (requestError) {
      setEmailStatus({ loading: false, message: '', error: requestError.message });
    }
  };

  const agents = report?.agents || [];
  const lobOptionsForFilter = filters.process_name
    ? (agentProcessOptions.lobsByProcess[filters.process_name] || [])
    : (report?.lob_options || agentProcessOptions.lobs || []);
  const lobOptionsForEmail = emailForm.process_name
    ? (agentProcessOptions.lobsByProcess[emailForm.process_name] || [])
    : (agentProcessOptions.lobs || []);

  return (
    <section className="admin-panel agent-report-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">SuperAdmin Administration</span>
          <h3>Agent Report</h3>
        </div>
        <button type="button" className="agent-report-send-btn" onClick={openEmailModal}>
          Send Report
        </button>
      </div>

      <form className="report-filters agent-report-filters" onSubmit={submitFilters}>
        <label>
          <span>Date</span>
          <input
            type="date"
            max={todayKey()}
            value={filters.date}
            onChange={(event) => updateFilter('date', event.target.value)}
            required
          />
        </label>
        <label>
          <span>Process</span>
          <select value={filters.process_name} onChange={(event) => updateFilter('process_name', event.target.value)}>
            <option value="">All Processes</option>
            {agentProcessOptions.processes.map((option) => (
              <option value={option} key={option}>{option}</option>
            ))}
          </select>
        </label>
        <label>
          <span>LOB</span>
          <select value={filters.lob_name} onChange={(event) => updateFilter('lob_name', event.target.value)}>
            <option value="">All LOBs</option>
            {lobOptionsForFilter.map((option) => (
              <option value={option} key={option}>{option}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="report-apply">Apply Filters</button>
      </form>

      {loading && <div className="report-loading">Loading agent report...</div>}
      {error && <div className="report-error" role="alert">{error}</div>}

      {!loading && !error && report && (
        <>
          <div className="report-kpi-grid">
            <article className="report-kpi report-kpi-navy">
              <span>Total Agents</span>
              <strong>{report.overall.total_agents}</strong>
            </article>
            <article className="report-kpi report-kpi-teal">
              <span>Present</span>
              <strong>{report.overall.present}</strong>
            </article>
            <article className="report-kpi report-kpi-rose">
              <span>Absent</span>
              <strong>{report.overall.absent}</strong>
            </article>
            <article className="report-kpi report-kpi-blue">
              <span>Avg Hours</span>
              <strong>{report.overall.avg_hours || '-'}</strong>
            </article>
          </div>

          <h4 className="agent-report-section-title">LOB-wise Summary</h4>
          <div className="agent-report-table-wrap">
            <table className="agent-report-table">
              <thead>
                <tr>
                  <th>LOB</th>
                  <th>Total Agents</th>
                  <th>Present</th>
                  <th>Absent</th>
                  <th>Avg Hours</th>
                </tr>
              </thead>
              <tbody>
                {report.by_lob.map((lob) => (
                  <tr key={lob.lob_name}>
                    <td>{lob.lob_name}</td>
                    <td>{lob.total_agents}</td>
                    <td>{lob.present}</td>
                    <td>{lob.absent}</td>
                    <td>{lob.avg_hours || '-'}</td>
                  </tr>
                ))}
                {!report.by_lob.length && (
                  <tr>
                    <td colSpan={5} className="agent-report-empty">No agents found for the selected filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 className="agent-report-section-title">Agent-wise Detail</h4>
          <div className="agent-report-table-wrap">
            <table className="agent-report-table">
              <thead>
                <tr>
                  <th>Agent Name</th>
                  <th>Emp Code</th>
                  <th>Process</th>
                  <th>LOB</th>
                  <th>Punch In</th>
                  <th>Punch Out</th>
                  <th>Total Hours</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.emp_code} className={agent.present ? '' : 'agent-report-absent'}>
                    <td>{agent.name}</td>
                    <td>{agent.emp_code}</td>
                    <td>{agent.process_name}</td>
                    <td>{agent.lob_name}</td>
                    <td>{agent.punch_in || '-'}</td>
                    <td>{agent.punch_out || '-'}</td>
                    <td>{agent.total_hours || '-'}</td>
                  </tr>
                ))}
                {!agents.length && (
                  <tr>
                    <td colSpan={7} className="agent-report-empty">No agents found for the selected filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {emailOpen && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEmailOpen(false);
          }}
        >
          <div className="modal-card">
            <h3>Send Report</h3>
            <form onSubmit={submitEmail} className="modal-form">
              <label>
                <span>Date</span>
                <input
                  type="date"
                  max={todayKey()}
                  value={emailForm.date}
                  onChange={(event) => updateEmailField('date', event.target.value)}
                  required
                />
              </label>
              <label>
                <span>Process</span>
                <select
                  value={emailForm.process_name}
                  onChange={(event) => updateEmailField('process_name', event.target.value)}
                >
                  <option value="">All Processes</option>
                  {agentProcessOptions.processes.map((option) => (
                    <option value={option} key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>LOB</span>
                <select
                  value={emailForm.lob_name}
                  onChange={(event) => updateEmailField('lob_name', event.target.value)}
                >
                  <option value="">All LOBs</option>
                  {lobOptionsForEmail.map((option) => (
                    <option value={option} key={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Manager Email</span>
                <input
                  type="email"
                  placeholder="manager@company.com"
                  value={emailForm.email}
                  onChange={(event) => updateEmailField('email', event.target.value)}
                  required
                />
              </label>
              {emailStatus.error && <div className="report-error" role="alert">{emailStatus.error}</div>}
              {emailStatus.message && <div className="modal-success" role="status">{emailStatus.message}</div>}
              <div className="modal-actions">
                <button type="button" className="cancel-btn" onClick={() => setEmailOpen(false)}>Close</button>
                <button type="submit" disabled={emailStatus.loading}>
                  {emailStatus.loading ? 'Sending...' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export default AgentReport;
