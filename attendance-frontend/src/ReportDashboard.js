import React, { useCallback, useEffect, useMemo, useState } from 'react';

const escapeCsv = (value) => {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
};

const downloadCsv = (filename, headers, rows) => {
  const csv = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => row.map(escapeCsv).join(','))
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const localDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

const ReportKpis = ({ metrics }) => {
  const cards = [
    { label: 'Mandate', value: formatNumber(metrics.mandate), note: 'Maximum active agents', tone: 'navy' },
    { label: 'Adherence', value: `${metrics.adherence_percent}%`, note: `${formatNumber(metrics.planned_agent_days)} planned agent-days`, tone: 'teal' },
    { label: 'Shrinkage', value: `${metrics.shrinkage_percent}%`, note: `${formatNumber(metrics.absent)} absent, ${formatNumber(metrics.half_day)} half day`, tone: 'rose' },
    { label: 'On Time', value: `${metrics.on_time_percent}%`, note: `${formatNumber(metrics.on_time)} attendance days`, tone: 'blue' },
    { label: 'Late', value: `${metrics.late_percent}%`, note: `${formatNumber(metrics.late)} attendance days`, tone: 'amber' }
  ];

  return (
    <div className="report-kpi-grid">
      {cards.map((card) => (
        <article className={`report-kpi report-kpi-${card.tone}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.note}</small>
        </article>
      ))}
    </div>
  );
};

const AttendanceDonut = ({ metrics }) => {
  const total = metrics.present + metrics.half_day + metrics.absent;
  const present = total ? (metrics.present / total) * 100 : 0;
  const halfDay = total ? (metrics.half_day / total) * 100 : 0;
  const donutStyle = {
    background: `conic-gradient(
      #0f766e 0 ${present}%,
      #f59e0b ${present}% ${present + halfDay}%,
      #e11d48 ${present + halfDay}% 100%
    )`
  };

  return (
    <article className="report-chart-card">
      <div className="report-chart-heading">
        <div>
          <span>Attendance Mix</span>
          <h4>Availability distribution</h4>
        </div>
        <small>{formatNumber(total)} agent-days</small>
      </div>
      <div className="report-donut-layout">
        <div className="report-donut" style={donutStyle}>
          <div>
            <strong>{metrics.adherence_percent}%</strong>
            <span>Adherence</span>
          </div>
        </div>
        <div className="report-legend">
          <span><i className="present" /> Present <strong>{formatNumber(metrics.present)}</strong></span>
          <span><i className="half-day" /> Half Day <strong>{formatNumber(metrics.half_day)}</strong></span>
          <span><i className="absent" /> Absent <strong>{formatNumber(metrics.absent)}</strong></span>
        </div>
      </div>
    </article>
  );
};

const ProcessBars = ({ processes }) => (
  <article className="report-chart-card">
    <div className="report-chart-heading">
      <div>
        <span>Process Comparison</span>
        <h4>Adherence by process</h4>
      </div>
      <small>{processes.length} processes</small>
    </div>
    <div className="report-bars">
      {processes.map((process) => (
        <div className="report-bar-row" key={process.name}>
          <div>
            <strong>{process.name}</strong>
            <span>Mandate {process.metrics.mandate}</span>
          </div>
          <div className="report-bar-track">
            <i style={{ width: `${Math.min(process.metrics.adherence_percent, 100)}%` }} />
          </div>
          <b>{process.metrics.adherence_percent}%</b>
        </div>
      ))}
      {processes.length === 0 && <p className="report-empty">No process data for this selection.</p>}
    </div>
  </article>
);

const StatusStack = ({ metrics }) => {
  const total = metrics.present + metrics.half_day + metrics.absent;
  const width = (value) => `${total ? (value / total) * 100 : 0}%`;
  return (
    <article className="report-chart-card report-status-card">
      <div className="report-chart-heading">
        <div>
          <span>Capacity</span>
          <h4>Planned vs delivered days</h4>
        </div>
        <small>{metrics.working_days} working days</small>
      </div>
      <div className="report-status-stack" aria-label="Attendance status distribution">
        <i className="present" style={{ width: width(metrics.present) }} />
        <i className="half-day" style={{ width: width(metrics.half_day) }} />
        <i className="absent" style={{ width: width(metrics.absent) }} />
      </div>
      <div className="report-capacity-values">
        <span><strong>{formatNumber(metrics.present)}</strong> Full adherence days</span>
        <span><strong>{formatNumber(metrics.half_day)}</strong> Half days</span>
        <span><strong>{formatNumber(metrics.absent)}</strong> Lost days</span>
      </div>
    </article>
  );
};

const AgentTable = ({ agents, agentCount }) => (
  <article className="report-table-card">
    <div className="report-chart-heading">
      <div>
        <span>Agent View</span>
        <h4>Individual adherence and punctuality</h4>
      </div>
      <small>
        {agents.length === agentCount ? `${agentCount} agents` : `Showing ${agents.length} of ${agentCount}`}
      </small>
    </div>
    <div className="report-table-scroll">
      <table className="report-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Process / LOB</th>
            <th>Manager Access</th>
            <th>Adherence</th>
            <th>On Time</th>
            <th>Late</th>
            <th>Shrinkage</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.emp_code}>
              <td><strong>{agent.name}</strong><span>{agent.emp_code}</span></td>
              <td><strong>{agent.process_name}</strong><span>{agent.lob_name}</span></td>
              <td>{agent.manager_name || 'Unassigned'}</td>
              <td><b className="metric-good">{agent.metrics.adherence_percent}%</b></td>
              <td>{agent.metrics.on_time_percent}%</td>
              <td>{agent.metrics.late_percent}%</td>
              <td><b className="metric-risk">{agent.metrics.shrinkage_percent}%</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {agents.length === 0 && <p className="report-empty">No agents match the selected filters.</p>}
    </div>
  </article>
);

function ReportDashboard({ apiBaseUrl, token, initialMonth }) {
  const todayKey = localDateKey(new Date());
  const monthStart = `${initialMonth}-01`;
  const monthEndCandidate = localDateKey(new Date(
    Number(initialMonth.slice(0, 4)),
    Number(initialMonth.slice(5, 7)),
    0
  ));
  const [filters, setFilters] = useState({
    date_from: monthStart,
    date_to: monthEndCandidate > todayKey ? todayKey : monthEndCandidate,
    process_name: '',
    lob_name: '',
    agent_search: ''
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [report, setReport] = useState(null);
  const [selectedSlide, setSelectedSlide] = useState('overall');
  const [loading, setLoading] = useState(true);
  const [downloadLoading, setDownloadLoading] = useState('');
  const [error, setError] = useState('');

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      Object.entries(appliedFilters).forEach(([key, value]) => {
        if (String(value).trim()) params.set(key, String(value).trim());
      });
      const response = await fetch(`${apiBaseUrl}/api/reports/adherence?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to load report');
      setReport(data);
      setSelectedSlide((currentSlide) => (
        data.processes.some((process) => process.name === currentSlide)
          ? currentSlide
          : 'overall'
      ));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, appliedFilters, token]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const slides = useMemo(() => (
    report ? ['overall', ...report.processes.map((process) => process.name)] : ['overall']
  ), [report]);
  const currentSlideIndex = Math.max(slides.indexOf(selectedSlide), 0);
  const selectedProcess = report?.processes.find((process) => process.name === selectedSlide);
  const visibleAgents = selectedProcess
    ? report.agents.filter((agent) => agent.process_name === selectedProcess.name)
    : (report?.agents || []);

  const updateFilter = (field, value) => {
    setFilters((current) => {
      const next = { ...current, [field]: value };
      if (field === 'process_name') next.lob_name = '';
      return next;
    });
  };

  const submitFilters = (event) => {
    event.preventDefault();
    setSelectedSlide(filters.process_name || 'overall');
    setAppliedFilters(filters);
  };

  const resetFilters = () => {
    const reset = {
      date_from: monthStart,
      date_to: monthEndCandidate > todayKey ? todayKey : monthEndCandidate,
      process_name: '',
      lob_name: '',
      agent_search: ''
    };
    setFilters(reset);
    setAppliedFilters(reset);
    setSelectedSlide('overall');
  };

  const downloadDateWise = () => {
    if (!report) return;
    downloadCsv(
      `date-wise-adherence-${report.date_from}-to-${report.date_to}.csv`,
      ['Date', 'Mandate', 'Present', 'Half Day', 'Absent', 'Adherence %', 'Shrinkage %', 'On Time', 'Late', 'On Time %', 'Late %'],
      report.daily_records.map((row) => [
        row.attendance_date,
        row.metrics.mandate,
        row.metrics.present,
        row.metrics.half_day,
        row.metrics.absent,
        row.metrics.adherence_percent,
        row.metrics.shrinkage_percent,
        row.metrics.on_time,
        row.metrics.late,
        row.metrics.on_time_percent,
        row.metrics.late_percent
      ])
    );
  };

  const downloadAgentWise = async () => {
    if (!report) return;
    setDownloadLoading('agent');
    setError('');
    try {
      const params = new URLSearchParams({ detail: 'agent' });
      Object.entries(appliedFilters).forEach(([key, value]) => {
        if (String(value).trim()) params.set(key, String(value).trim());
      });
      const response = await fetch(`${apiBaseUrl}/api/reports/adherence?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Failed to prepare agent report');
      downloadCsv(
        `agent-wise-adherence-${data.date_from}-to-${data.date_to}.csv`,
        ['Emp Code', 'Agent', 'Process', 'LOB', 'Manager', 'Mandate Days', 'Present', 'Half Day', 'Absent', 'Adherence %', 'Shrinkage %', 'On Time %', 'Late %'],
        data.agents.map((agent) => [
          agent.emp_code,
          agent.name,
          agent.process_name,
          agent.lob_name,
          agent.manager_name || 'Unassigned',
          agent.metrics.planned_agent_days,
          agent.metrics.present,
          agent.metrics.half_day,
          agent.metrics.absent,
          agent.metrics.adherence_percent,
          agent.metrics.shrinkage_percent,
          agent.metrics.on_time_percent,
          agent.metrics.late_percent
        ])
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDownloadLoading('');
    }
  };

  const slideBack = () => {
    setSelectedSlide(slides[Math.max(currentSlideIndex - 1, 0)]);
  };

  const slideNext = () => {
    setSelectedSlide(slides[Math.min(currentSlideIndex + 1, slides.length - 1)]);
  };

  return (
    <section className="report-page" aria-label="Adherence report dashboard">
      <div className="report-hero">
        <div>
          <span className="report-eyebrow">Workforce Intelligence</span>
          <h2>Adherence Command Center</h2>
          <p>Process and LOB capacity, punctuality, and attendance shrinkage in one view.</p>
        </div>
        <div className="report-downloads">
          <button type="button" onClick={downloadDateWise} disabled={!report}>Download Date-wise</button>
          <button type="button" onClick={downloadAgentWise} disabled={!report || downloadLoading === 'agent'}>
            {downloadLoading === 'agent' ? 'Preparing Agent Report...' : 'Download Agent-wise'}
          </button>
        </div>
      </div>

      <form className="report-filters" onSubmit={submitFilters}>
        <label>
          <span>From Date</span>
          <input type="date" max={todayKey} value={filters.date_from} onChange={(event) => updateFilter('date_from', event.target.value)} required />
        </label>
        <label>
          <span>To Date</span>
          <input type="date" min={filters.date_from} max={todayKey} value={filters.date_to} onChange={(event) => updateFilter('date_to', event.target.value)} required />
        </label>
        <label>
          <span>Process</span>
          <select value={filters.process_name} onChange={(event) => updateFilter('process_name', event.target.value)}>
            <option value="">All Processes</option>
            {(report?.process_options || []).map((process) => <option value={process} key={process}>{process}</option>)}
          </select>
        </label>
        <label>
          <span>LOB</span>
          <select value={filters.lob_name} onChange={(event) => updateFilter('lob_name', event.target.value)}>
            <option value="">All LOBs</option>
            {(report?.lob_options || []).map((lob) => <option value={lob} key={lob}>{lob}</option>)}
          </select>
        </label>
        <label className="report-agent-filter">
          <span>Agent</span>
          <input type="search" placeholder="Name or employee code" value={filters.agent_search} onChange={(event) => updateFilter('agent_search', event.target.value)} />
        </label>
        <button type="submit" className="report-apply">Apply Filters</button>
        <button type="button" className="report-reset" onClick={resetFilters}>Reset</button>
      </form>

      {loading && <div className="report-loading">Building the report...</div>}
      {error && <div className="report-error" role="alert">{error}</div>}

      {!loading && report && (
        <>
          <div className="report-scope-strip">
            <div>
              <span>Access Scope</span>
              <strong>{report.scope_label}</strong>
            </div>
            <div>
              <span>Reporting Window</span>
              <strong>{report.date_from} to {report.date_to}</strong>
            </div>
            <div>
              <span>Late Rule</span>
              <strong>
                {report.shift_rule_label
                  || `After ${report.shift_start} + ${report.late_grace_minutes} min grace`}
              </strong>
            </div>
          </div>

          <nav className="report-slide-nav" aria-label="Report slides">
            {slides.map((slide, index) => (
              <button
                type="button"
                className={selectedSlide === slide ? 'active' : ''}
                onClick={() => setSelectedSlide(slide)}
                key={slide}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                {slide === 'overall' ? 'Overall' : slide}
              </button>
            ))}
          </nav>

          <div className="report-slide">
            <div className="report-slide-title">
              <div>
                <span>{selectedProcess ? 'Process Slide' : 'Overall Slide'}</span>
                <h3>{selectedProcess ? selectedProcess.name : 'Overall Workforce View'}</h3>
                <p>{selectedProcess ? `${selectedProcess.lobs.length} LOBs in this process` : `${report.processes.length} processes in your access scope`}</p>
              </div>
              <div className="report-slide-controls">
                <button type="button" onClick={slideBack} disabled={currentSlideIndex === 0}>Previous</button>
                <strong>{currentSlideIndex + 1} / {slides.length}</strong>
                <button type="button" onClick={slideNext} disabled={currentSlideIndex === slides.length - 1}>Next</button>
              </div>
            </div>

            <ReportKpis metrics={selectedProcess?.metrics || report.overall} />

            <div className="report-chart-grid">
              <AttendanceDonut metrics={selectedProcess?.metrics || report.overall} />
              {selectedProcess
                ? <StatusStack metrics={selectedProcess.metrics} />
                : <ProcessBars processes={report.processes} />}
            </div>

            {selectedProcess && (
              <article className="report-lob-section">
                <div className="report-chart-heading">
                  <div>
                    <span>LOB Drilldown</span>
                    <h4>{selectedProcess.name} performance</h4>
                  </div>
                  <small>Mandate is maximum active agents</small>
                </div>
                <div className="report-lob-grid">
                  {selectedProcess.lobs.map((lob) => (
                    <div className="report-lob-card" key={lob.name}>
                      <div>
                        <span>{lob.name}</span>
                        <strong>{lob.metrics.adherence_percent}%</strong>
                      </div>
                      <div className="report-lob-progress"><i style={{ width: `${Math.min(lob.metrics.adherence_percent, 100)}%` }} /></div>
                      <dl>
                        <div><dt>Mandate</dt><dd>{lob.metrics.mandate}</dd></div>
                        <div><dt>On Time</dt><dd>{lob.metrics.on_time_percent}%</dd></div>
                        <div><dt>Late</dt><dd>{lob.metrics.late_percent}%</dd></div>
                        <div><dt>Shrinkage</dt><dd>{lob.metrics.shrinkage_percent}%</dd></div>
                      </dl>
                    </div>
                  ))}
                </div>
              </article>
            )}

            <AgentTable agents={visibleAgents} agentCount={selectedProcess ? visibleAgents.length : report.agent_count} />

            <p className="report-methodology">{report.methodology}</p>
          </div>
        </>
      )}
    </section>
  );
}

export default ReportDashboard;
