# Agent View, Employee Report & Download Restrictions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Manager/SuperAdmin Agent View monthly dashboard, a personal My Report section for all employees (9:30–6:30 shift, date-wise), and restrict CSV downloads to SuperAdmin only.

**Architecture:** New backend endpoint `/api/reports/agent-view` computes per-employee punch/login metrics from SQL Server attendance joined with MySQL employee data, scoped to role. Frontend adds an Agent View tab to ReportDashboard, a My Report panel to App.js (using already-loaded attendance state), and gates download buttons behind an `isSuperAdmin` prop.

**Tech Stack:** FastAPI + pymssql (SQL Server) + mysql-connector (MySQL) for backend; React for frontend.

---

## File Map

| File | Change |
|---|---|
| `attendance-frontend/backend/main.py` | Add `GET /api/reports/agent-view` endpoint after line 3419 |
| `attendance-frontend/src/App.js` | Add `my_report` to `getAllowedTasks`, add My Report panel, pass `isSuperAdmin` to ReportDashboard |
| `attendance-frontend/src/ReportDashboard.js` | Accept `isSuperAdmin` prop, gate downloads, add Agent View tab |
| `attendance-frontend/src/App.css` | Styles for Agent View table and My Report panel |

---

## Task 1: Backend — Agent View Endpoint

**Files:**
- Modify: `attendance-frontend/backend/main.py` — insert after line 3419 (end of adherence endpoint), before `@app.get("/api/attendance", ...)` at line 3420

- [ ] **Step 1: Add Pydantic models** — add these two models after the existing model definitions (search for `class ReportOut` and add these nearby, or add them just before the new endpoint):

```python
class AgentViewEmployeeOut(BaseModel):
    emp_code: str
    name: str
    process_name: str
    lob_name: str
    manager_name: Optional[str]
    avg_punch_in: Optional[str]
    avg_punch_out: Optional[str]
    total_login_hours: str
    present: int
    half_day: int
    absent: int
    late_days: int
    working_days: int
    late_percent: float
    adherence_percent: float

class AgentViewOut(BaseModel):
    month: str
    mandate: int
    working_days: int
    employees: list[AgentViewEmployeeOut]
```

- [ ] **Step 2: Add the endpoint** — insert this full function immediately before the `@app.get("/api/attendance", ...)` decorator (after the closing brace of `get_adherence_report`):

```python
@app.get("/api/reports/agent-view", response_model=AgentViewOut)
def get_agent_view(
    month: Optional[str] = Query(None),
    process_name: Optional[str] = Query(None),
    lob_name: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user)
):
    """Monthly per-employee attendance metrics scoped to role. SuperAdmin sees all, Manager sees assigned only."""
    role = str(current_user.get("role", "")).lower()
    is_superadmin = role == "superadmin"

    if not month:
        month = datetime.now().strftime("%Y-%m")
    try:
        year, mon = map(int, month.split("-"))
    except ValueError:
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    start_dt = datetime(year, mon, 1)
    if mon == 12:
        end_dt = datetime(year + 1, 1, 1) - timedelta(days=1)
    else:
        end_dt = datetime(year, mon + 1, 1) - timedelta(days=1)

    mysql_conn = get_mysql_connection()
    mysql_cursor = mysql_conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(mysql_cursor)

        manager_row = None
        if not is_superadmin:
            manager_row = get_manager_for_user(mysql_cursor, current_user["emp_code"])
            if not manager_row:
                raise HTTPException(status_code=403, detail="Manager or SuperAdmin access required")

        # Employees in scope
        emp_sql = """
            SELECT DISTINCT
                e.EmpCode AS emp_code,
                e.EmpName AS name,
                e.Designation AS designation,
                COALESCE(ap.`Process`, e.process_name, 'Unassigned') AS process_name,
                COALESCE(ap.LOBName, e.lob_name, 'Unassigned') AS lob_name,
                m.Manager_Name AS manager_name
            FROM EmployeeDetails e
            LEFT JOIN AgentProcess ap ON ap.EmpCode = e.EmpCode
            LEFT JOIN Managers m ON e.assign_manager_id = m.managar_unique_code
            WHERE LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
              AND LOWER(COALESCE(e.status, 'active')) = 'active'
        """
        emp_params = []
        if not is_superadmin:
            emp_sql += " AND e.assign_manager_id = %s"
            emp_params.append(manager_row["managar_unique_code"])
        if process_name:
            emp_sql += " AND COALESCE(ap.`Process`, e.process_name) = %s"
            emp_params.append(process_name)
        if lob_name:
            emp_sql += " AND COALESCE(ap.LOBName, e.lob_name) = %s"
            emp_params.append(lob_name)
        emp_sql += " ORDER BY name"
        mysql_cursor.execute(emp_sql, tuple(emp_params))
        employees = mysql_cursor.fetchall()

        # Mandate = count of Active Executives in scope
        man_sql = """
            SELECT COUNT(DISTINCT e.EmpCode) AS cnt
            FROM EmployeeDetails e
            LEFT JOIN AgentProcess ap ON ap.EmpCode = e.EmpCode
            WHERE LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
              AND LOWER(COALESCE(e.status, 'active')) = 'active'
              AND LOWER(COALESCE(e.Designation, '')) = 'executive'
        """
        man_params = []
        if not is_superadmin:
            man_sql += " AND e.assign_manager_id = %s"
            man_params.append(manager_row["managar_unique_code"])
        if process_name:
            man_sql += " AND COALESCE(ap.`Process`, e.process_name) = %s"
            man_params.append(process_name)
        if lob_name:
            man_sql += " AND COALESCE(ap.LOBName, e.lob_name) = %s"
            man_params.append(lob_name)
        mysql_cursor.execute(man_sql, tuple(man_params))
        mandate = (mysql_cursor.fetchone() or {}).get("cnt", 0)

        # Holidays for the month
        mysql_cursor.execute(
            "SELECT HolidayDate FROM Holidays WHERE HolidayDate >= %s AND HolidayDate <= %s",
            (start_dt.date().isoformat(), end_dt.date().isoformat())
        )
        holiday_dates = set()
        for row in mysql_cursor.fetchall():
            hd = row["HolidayDate"]
            holiday_dates.add(hd.isoformat() if hasattr(hd, "isoformat") else str(hd))

    finally:
        mysql_cursor.close()
        mysql_conn.close()

    # Working days in month (non-Sunday, non-holiday)
    working_days = 0
    cur = start_dt.date()
    while cur <= end_dt.date():
        if cur.weekday() != 6 and cur.isoformat() not in holiday_dates:
            working_days += 1
        cur += timedelta(days=1)

    if not employees:
        return {"month": month, "mandate": mandate, "working_days": working_days, "employees": []}

    emp_codes = [e["emp_code"].upper() for e in employees]
    employee_by_code = {e["emp_code"].upper(): e for e in employees}

    LATE_CUTOFF = time(9, 30)
    PRESENT_MINUTES = 540
    HALF_DAY_MINUTES = 270

    attendance_by_emp: dict = {code: [] for code in emp_codes}
    try:
        placeholders = ", ".join(["%s"] * len(emp_codes))
        sql = f"""
            SELECT
                UserID,
                CAST(Edatetime AS DATE) AS AttendanceDate,
                MIN(Edatetime) AS FirstPunchIn,
                MAX(Edatetime) AS LastPunchOut,
                DATEDIFF(MINUTE, MIN(Edatetime), MAX(Edatetime)) AS WorkingMinutes
            FROM Mx_ATDEventTrn
            WHERE UserID IN ({placeholders})
              AND Edatetime >= %s
              AND Edatetime < %s
            GROUP BY UserID, CAST(Edatetime AS DATE)
        """
        att_conn = get_attendance_connection()
        try:
            att_cursor = att_conn.cursor()
            att_cursor.execute(sql, tuple(emp_codes) + (start_dt, end_dt + timedelta(days=1)))
            for row in att_cursor.fetchall():
                uid = str(row[0]).upper()
                if uid in attendance_by_emp:
                    attendance_by_emp[uid].append({
                        "first_punch": row[2],
                        "last_punch": row[3],
                        "working_minutes": int(row[4] or 0)
                    })
        finally:
            att_conn.close()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Attendance DB error: {exc}")

    def _mins_to_hhmm(total_mins: float) -> str:
        m = int(total_mins)
        return f"{m // 60:02d}:{m % 60:02d}"

    result = []
    for emp in employees:
        code = emp["emp_code"].upper()
        records = attendance_by_emp.get(code, [])
        present = half_day = late_days = total_minutes = 0
        in_times: list = []
        out_times: list = []

        for rec in records:
            wm = rec["working_minutes"]
            total_minutes += wm
            if wm >= PRESENT_MINUTES:
                present += 1
            elif wm >= HALF_DAY_MINUTES:
                half_day += 1
            else:
                continue
            fp = rec["first_punch"]
            if not isinstance(fp, datetime):
                fp = datetime.fromisoformat(str(fp))
            if fp.time() > LATE_CUTOFF:
                late_days += 1
            in_times.append(fp.hour * 60 + fp.minute)
            lp = rec["last_punch"]
            if not isinstance(lp, datetime):
                lp = datetime.fromisoformat(str(lp))
            out_times.append(lp.hour * 60 + lp.minute)

        absent = max(working_days - present - half_day, 0)
        attended = present + half_day
        avg_in = _mins_to_hhmm(sum(in_times) / len(in_times)) if in_times else None
        avg_out = _mins_to_hhmm(sum(out_times) / len(out_times)) if out_times else None
        total_h = total_minutes // 60
        total_m = total_minutes % 60
        late_pct = round(late_days / attended * 100, 1) if attended > 0 else 0.0
        adh_pct = round(attended / working_days * 100, 1) if working_days > 0 else 0.0

        result.append({
            "emp_code": emp["emp_code"],
            "name": emp["name"],
            "process_name": emp["process_name"],
            "lob_name": emp["lob_name"],
            "manager_name": emp.get("manager_name"),
            "avg_punch_in": avg_in,
            "avg_punch_out": avg_out,
            "total_login_hours": f"{total_h}:{total_m:02d}",
            "present": present,
            "half_day": half_day,
            "absent": absent,
            "late_days": late_days,
            "working_days": working_days,
            "late_percent": late_pct,
            "adherence_percent": adh_pct
        })

    return {"month": month, "mandate": mandate, "working_days": working_days, "employees": result}
```

- [ ] **Step 3: Verify imports** — confirm `time` is in the existing import line (it is: `from datetime import date, datetime, time, timedelta, timezone`). No new imports needed.

- [ ] **Step 4: Smoke-test the endpoint** — start the backend and hit it with curl (replace token with a valid one):

```bash
curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:8000/api/reports/agent-view?month=2026-06"
```

Expected: JSON with `month`, `mandate`, `working_days`, `employees` array.

- [ ] **Step 5: Commit**

```bash
git add attendance-frontend/backend/main.py
git commit -m "feat: add /api/reports/agent-view endpoint with per-employee monthly metrics"
```

---

## Task 2: Frontend — Gate Downloads Behind `isSuperAdmin` Prop

**Files:**
- Modify: `attendance-frontend/src/App.js` line ~2177
- Modify: `attendance-frontend/src/ReportDashboard.js` line ~186 and ~351

- [ ] **Step 1: Pass `isSuperAdmin` prop in App.js** — find the `ReportDashboard` call (~line 2177) and change it:

```jsx
{activeAdminTask === 'reports' && (
  <ReportDashboard
    apiBaseUrl={API_BASE_URL}
    token={token}
    initialMonth={selectedMonth}
    isSuperAdmin={isSuperAdmin}
  />
)}
```

- [ ] **Step 2: Accept `isSuperAdmin` in ReportDashboard** — change the function signature at line 186:

```js
function ReportDashboard({ apiBaseUrl, token, initialMonth, isSuperAdmin }) {
```

- [ ] **Step 3: Gate the download buttons** — find the `report-downloads` div (~line 351) and wrap it:

```jsx
{isSuperAdmin && (
  <div className="report-downloads">
    <button type="button" onClick={downloadDateWise} disabled={!report}>Download Date-wise</button>
    <button type="button" onClick={downloadAgentWise} disabled={!report || downloadLoading === 'agent'}>
      {downloadLoading === 'agent' ? 'Preparing Agent Report...' : 'Download Agent-wise'}
    </button>
  </div>
)}
```

- [ ] **Step 4: Verify** — log in as Manager → Reports → confirm no download buttons. Log in as SuperAdmin → confirm buttons appear.

- [ ] **Step 5: Commit**

```bash
git add attendance-frontend/src/App.js attendance-frontend/src/ReportDashboard.js
git commit -m "feat: restrict report download buttons to SuperAdmin only"
```

---

## Task 3: Frontend — Agent View Tab in ReportDashboard

**Files:**
- Modify: `attendance-frontend/src/ReportDashboard.js`

- [ ] **Step 1: Add Agent View state** — inside the `ReportDashboard` function, after the existing `useState` calls (~line 204), add:

```js
const [activeTab, setActiveTab] = useState('adherence');
const [agentMonth, setAgentMonth] = useState(initialMonth);
const [agentProcessFilter, setAgentProcessFilter] = useState('');
const [agentLobFilter, setAgentLobFilter] = useState('');
const [agentData, setAgentData] = useState(null);
const [agentLoading, setAgentLoading] = useState(false);
const [agentError, setAgentError] = useState('');
```

- [ ] **Step 2: Add `fetchAgentView` function** — add after `fetchReport` (~line 232):

```js
const fetchAgentView = useCallback(async () => {
  setAgentLoading(true);
  setAgentError('');
  try {
    const params = new URLSearchParams({ month: agentMonth });
    if (agentProcessFilter) params.set('process_name', agentProcessFilter);
    if (agentLobFilter) params.set('lob_name', agentLobFilter);
    const response = await fetch(`${apiBaseUrl}/api/reports/agent-view?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || 'Failed to load agent view');
    setAgentData(data);
  } catch (err) {
    setAgentError(err.message);
  } finally {
    setAgentLoading(false);
  }
}, [apiBaseUrl, token, agentMonth, agentProcessFilter, agentLobFilter]);
```

- [ ] **Step 3: Auto-fetch Agent View when tab is active** — add after the existing `useEffect` for `fetchReport`:

```js
useEffect(() => {
  if (activeTab === 'agent-view') fetchAgentView();
}, [activeTab, fetchAgentView]);
```

- [ ] **Step 4: Add CSV download helper for Agent View** — add after `downloadAgentWise` function:

```js
const downloadAgentViewCsv = () => {
  if (!agentData) return;
  downloadCsv(
    `agent-view-${agentData.month}.csv`,
    ['Emp Code', 'Name', 'Process', 'LOB', 'Manager', 'Avg Punch In', 'Avg Punch Out',
     'Total Login Hrs', 'Present', 'Half Day', 'Absent', 'Late Days', 'Working Days',
     'Late %', 'Adherence %'],
    agentData.employees.map((e) => [
      e.emp_code, e.name, e.process_name, e.lob_name, e.manager_name || 'Unassigned',
      e.avg_punch_in || '-', e.avg_punch_out || '-', e.total_login_hours,
      e.present, e.half_day, e.absent, e.late_days, e.working_days,
      e.late_percent, e.adherence_percent
    ])
  );
};
```

- [ ] **Step 5: Add tab switcher and Agent View UI** — find the opening `<section className="report-page"` and its `<div className="report-hero">`. Add a tab bar right after the hero div, and wrap the existing adherence content. Replace the `return (` block with the following structure:

```jsx
return (
  <section className="report-page" aria-label="Adherence report dashboard">
    <div className="report-hero">
      <div>
        <span className="report-eyebrow">Workforce Intelligence</span>
        <h2>Adherence Command Center</h2>
        <p>Process and LOB capacity, punctuality, and attendance shrinkage in one view.</p>
      </div>
      {isSuperAdmin && activeTab === 'adherence' && (
        <div className="report-downloads">
          <button type="button" onClick={downloadDateWise} disabled={!report}>Download Date-wise</button>
          <button type="button" onClick={downloadAgentWise} disabled={!report || downloadLoading === 'agent'}>
            {downloadLoading === 'agent' ? 'Preparing Agent Report...' : 'Download Agent-wise'}
          </button>
        </div>
      )}
      {isSuperAdmin && activeTab === 'agent-view' && agentData && (
        <div className="report-downloads">
          <button type="button" onClick={downloadAgentViewCsv}>Download Agent View CSV</button>
        </div>
      )}
    </div>

    <div className="report-tab-bar">
      <button
        type="button"
        className={activeTab === 'adherence' ? 'active' : ''}
        onClick={() => setActiveTab('adherence')}
      >
        Adherence Dashboard
      </button>
      <button
        type="button"
        className={activeTab === 'agent-view' ? 'active' : ''}
        onClick={() => setActiveTab('agent-view')}
      >
        Agent View
      </button>
    </div>

    {activeTab === 'adherence' && (
      <>
        <form className="report-filters" onSubmit={submitFilters}>
          {/* --- existing filter form contents unchanged --- */}
        </form>
        {/* --- all existing adherence content unchanged --- */}
      </>
    )}

    {activeTab === 'agent-view' && (
      <div className="agent-view-panel">
        <div className="agent-view-filters">
          <label>
            <span>Month</span>
            <input
              type="month"
              max={todayKey.slice(0, 7)}
              value={agentMonth}
              onChange={(e) => setAgentMonth(e.target.value)}
            />
          </label>
          {isSuperAdmin && agentData && (
            <>
              <label>
                <span>Process</span>
                <select value={agentProcessFilter} onChange={(e) => { setAgentProcessFilter(e.target.value); setAgentLobFilter(''); }}>
                  <option value="">All Processes</option>
                  {[...new Set(agentData.employees.map((e) => e.process_name))].sort().map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>LOB</span>
                <select value={agentLobFilter} onChange={(e) => setAgentLobFilter(e.target.value)}>
                  <option value="">All LOBs</option>
                  {[...new Set(
                    agentData.employees
                      .filter((e) => !agentProcessFilter || e.process_name === agentProcessFilter)
                      .map((e) => e.lob_name)
                  )].sort().map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button type="button" className="report-apply" onClick={fetchAgentView}>Apply</button>
        </div>

        {agentLoading && <div className="report-loading">Loading agent data...</div>}
        {agentError && <div className="report-error" role="alert">{agentError}</div>}

        {!agentLoading && agentData && (
          <>
            <div className="agent-view-kpis">
              <article className="agent-kpi agent-kpi-navy">
                <span>Mandate</span>
                <strong>{agentData.mandate}</strong>
                <small>Active executives in scope</small>
              </article>
              <article className="agent-kpi agent-kpi-teal">
                <span>Employees</span>
                <strong>{agentData.employees.length}</strong>
                <small>In current scope</small>
              </article>
              <article className="agent-kpi agent-kpi-blue">
                <span>Avg Adherence</span>
                <strong>
                  {agentData.employees.length
                    ? `${(agentData.employees.reduce((s, e) => s + e.adherence_percent, 0) / agentData.employees.length).toFixed(1)}%`
                    : '—'}
                </strong>
                <small>Across all agents</small>
              </article>
              <article className="agent-kpi agent-kpi-amber">
                <span>Avg Late</span>
                <strong>
                  {agentData.employees.length
                    ? `${(agentData.employees.reduce((s, e) => s + e.late_percent, 0) / agentData.employees.length).toFixed(1)}%`
                    : '—'}
                </strong>
                <small>Across all agents</small>
              </article>
              <article className="agent-kpi agent-kpi-slate">
                <span>Working Days</span>
                <strong>{agentData.working_days}</strong>
                <small>Non-Sunday non-holiday</small>
              </article>
            </div>

            <div className="agent-view-table-wrap">
              <table className="agent-view-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Process / LOB</th>
                    <th>Manager</th>
                    <th>Avg Punch In</th>
                    <th>Avg Punch Out</th>
                    <th>Login Hrs</th>
                    <th>P / HD / A</th>
                    <th>Late Days</th>
                    <th>Late %</th>
                    <th>Adherence %</th>
                  </tr>
                </thead>
                <tbody>
                  {agentData.employees
                    .filter((e) => (!agentProcessFilter || e.process_name === agentProcessFilter) && (!agentLobFilter || e.lob_name === agentLobFilter))
                    .map((emp) => (
                      <tr key={emp.emp_code}>
                        <td><strong>{emp.name}</strong><span>{emp.emp_code}</span></td>
                        <td><strong>{emp.process_name}</strong><span>{emp.lob_name}</span></td>
                        <td>{emp.manager_name || 'Unassigned'}</td>
                        <td>{emp.avg_punch_in || '—'}</td>
                        <td>{emp.avg_punch_out || '—'}</td>
                        <td>{emp.total_login_hours}</td>
                        <td>
                          <span className="av-p">{emp.present}P</span>
                          {' / '}
                          <span className="av-hd">{emp.half_day}HD</span>
                          {' / '}
                          <span className="av-a">{emp.absent}A</span>
                        </td>
                        <td>{emp.late_days}</td>
                        <td className={emp.late_percent > 30 ? 'metric-risk' : ''}>{emp.late_percent}%</td>
                        <td className={emp.adherence_percent >= 80 ? 'metric-good' : 'metric-risk'}>{emp.adherence_percent}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {agentData.employees.length === 0 && (
                <p className="report-empty">No employees found in this scope.</p>
              )}
            </div>
          </>
        )}
      </div>
    )}
  </section>
);
```

> **Important:** When inserting this return block, keep all the existing JSX for the adherence tab (the `<form className="report-filters">`, the slides, charts, etc.) inside the `{activeTab === 'adherence' && (<> ... </>)}` wrapper. Do not delete any existing adherence JSX — just wrap it.

- [ ] **Step 6: Commit**

```bash
git add attendance-frontend/src/ReportDashboard.js
git commit -m "feat: add Agent View tab to ReportDashboard with monthly per-employee metrics"
```

---

## Task 4: Frontend — My Report Section (Employee Personal Report)

**Files:**
- Modify: `attendance-frontend/src/App.js`

- [ ] **Step 1: Add `my_report` to all roles in `getAllowedTasks`** — find the function (~line 59) and replace it entirely:

```js
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
```

- [ ] **Step 2: Clear search when SuperAdmin opens My Report** — find the `openTask` function (~line 1369). Add this block at the top of the function body, before the existing `setActiveAdminTask(task)`:

```js
const openTask = (task) => {
  if (!getAllowedTasks(role, isManager).includes(task)) return;

  // For SuperAdmin: ensure My Report shows own data, not a search result
  if (task === 'my_report' && isSuperAdmin) {
    setSearchEmpCode('');
    setSearchEmpName('');
    setSearchVersion((v) => v + 1);
  }

  setActiveAdminTask(task);
  // ... rest of the existing openTask body unchanged
```

- [ ] **Step 3: Add "My Report" button to profile popup** — find `<div className="profile-actions task-profile-actions">` and add this as the first button inside it:

```jsx
{allowedTasks.includes('my_report') && (
  <button
    className="profile-action profile-action-myreport"
    type="button"
    onClick={() => openTask('my_report')}
  >
    My Report
  </button>
)}
```

- [ ] **Step 4: Add "My Report" button to the sidebar Task Center** — find the `<aside className="admin-task-nav" ...>` block. Add this as the first button after `<div className="admin-task-nav-head">...</div>`:

```jsx
{allowedTasks.includes('my_report') && (
  <button
    type="button"
    className={activeAdminTask === 'my_report' ? 'active' : ''}
    onClick={() => openTask('my_report')}
  >
    <span>0</span> My Report
  </button>
)}
```

- [ ] **Step 5: Add the My Report panel render** — find `{activeAdminTask === 'reports' && (` and add the My Report panel **before** it. This panel reads from the existing `attendance`, `holidays`, `attendanceByDate`, `holidayByDate`, `selectedMonth`, `employeeName`, `employeeCode` state that is already in App scope.

Add a helper function near the top of the `App` function body (after state declarations, before the return statement):

```js
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
```

Then add the panel render block (find `{activeAdminTask === 'reports' &&` and insert this **before** it):

```jsx
{activeAdminTask === 'my_report' && (() => {
  const rows = buildMyReportRows();
  const HALF_DAY_MINUTES = 270;
  const PRESENT_MINUTES = 540;
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
        <div className="my-kpi my-kpi-blue">
          <span>Working Days</span>
          <strong>{workingDays}</strong>
        </div>
        <div className="my-kpi my-kpi-green">
          <span>Present</span>
          <strong>{presentRows.length}</strong>
        </div>
        <div className="my-kpi my-kpi-amber">
          <span>Half Day</span>
          <strong>{halfDayRows.length}</strong>
        </div>
        <div className="my-kpi my-kpi-red">
          <span>Absent</span>
          <strong>{workingRows.filter((r) => r.label === 'Absent').length}</strong>
        </div>
        <div className="my-kpi my-kpi-teal">
          <span>On Time</span>
          <strong>{onTimeRows.length}</strong>
        </div>
        <div className="my-kpi my-kpi-orange">
          <span>Late</span>
          <strong>{lateRows.length}</strong>
        </div>
        <div className="my-kpi my-kpi-navy">
          <span>Adherence</span>
          <strong>{adherencePct}%</strong>
        </div>
        <div className="my-kpi my-kpi-rose">
          <span>Late %</span>
          <strong>{latePct}%</strong>
        </div>
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
```

- [ ] **Step 6: Commit**

```bash
git add attendance-frontend/src/App.js
git commit -m "feat: add My Report section with date-wise late/adherence report for all employees"
```

---

## Task 5: CSS — Styles for Agent View and My Report

**Files:**
- Modify: `attendance-frontend/src/App.css` — append to end of file

- [ ] **Step 1: Append all styles** to the end of [attendance-frontend/src/App.css](attendance-frontend/src/App.css):

```css
/* ===== Report Tab Bar ===== */
.report-tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 2px solid #e2e8f0;
  margin-bottom: 20px;
}
.report-tab-bar button {
  padding: 10px 20px;
  border: none;
  background: none;
  color: #64748b;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  transition: color 0.15s;
}
.report-tab-bar button.active {
  color: #1e40af;
  border-bottom-color: #1e40af;
}
.report-tab-bar button:hover:not(.active) {
  color: #334155;
}

/* ===== Agent View Panel ===== */
.agent-view-panel { padding: 4px 0; }

.agent-view-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 20px;
}
.agent-view-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: #475569;
}
.agent-view-filters input,
.agent-view-filters select {
  padding: 7px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 13px;
}

.agent-view-kpis {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}
.agent-kpi {
  flex: 1 1 140px;
  min-width: 120px;
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-kpi span { font-size: 12px; font-weight: 500; opacity: 0.75; }
.agent-kpi strong { font-size: 24px; font-weight: 700; }
.agent-kpi small { font-size: 11px; opacity: 0.65; }
.agent-kpi-navy { background: #1e3a5f; color: #fff; }
.agent-kpi-teal { background: #0f766e; color: #fff; }
.agent-kpi-blue { background: #1d4ed8; color: #fff; }
.agent-kpi-amber { background: #d97706; color: #fff; }
.agent-kpi-slate { background: #475569; color: #fff; }

.agent-view-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.agent-view-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.agent-view-table th {
  background: #f1f5f9;
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
}
.agent-view-table td {
  padding: 9px 12px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.agent-view-table td strong { display: block; }
.agent-view-table td span { font-size: 11px; color: #94a3b8; }
.agent-view-table tbody tr:hover { background: #f8fafc; }
.av-p { color: #0f766e; font-weight: 600; }
.av-hd { color: #d97706; font-weight: 600; }
.av-a { color: #dc2626; font-weight: 600; }

/* ===== My Report Panel ===== */
.my-report-panel {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.07);
  padding: 24px;
  margin: 16px 0;
}
.my-report-panel .panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 12px;
}
.my-report-month-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.my-report-shift-note {
  font-size: 12px;
  color: #64748b;
  background: #f8fafc;
  border-radius: 6px;
  padding: 8px 14px;
  margin-bottom: 16px;
}

.my-report-kpis {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 20px;
}
.my-kpi {
  flex: 1 1 100px;
  min-width: 90px;
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #fff;
}
.my-kpi span { font-size: 11px; font-weight: 500; opacity: 0.8; }
.my-kpi strong { font-size: 22px; font-weight: 700; }
.my-kpi-blue { background: #1d4ed8; }
.my-kpi-green { background: #15803d; }
.my-kpi-amber { background: #d97706; }
.my-kpi-red { background: #dc2626; }
.my-kpi-teal { background: #0f766e; }
.my-kpi-orange { background: #ea580c; }
.my-kpi-navy { background: #1e3a5f; }
.my-kpi-rose { background: #be123c; }

.my-report-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.07);
}
.my-report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.my-report-table th {
  background: #f1f5f9;
  padding: 10px 14px;
  text-align: left;
  font-weight: 600;
  color: #334155;
  white-space: nowrap;
  position: sticky;
  top: 0;
}
.my-report-table td {
  padding: 8px 14px;
  border-bottom: 1px solid #f1f5f9;
}
.my-report-table tr.mr-holiday { background: #fef9c3; }
.my-report-table tr.mr-off { background: #f1f5f9; color: #94a3b8; }
.my-report-table tr.mr-absent { background: #fff1f2; }
.my-report-table tr.mr-present { background: #f0fdf4; }
.my-report-table tr.mr-halfday { background: #fffbeb; }
.my-report-table tr.mr-future { background: #fafafa; color: #cbd5e1; }

.mr-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.mr-badge.mr-present { background: #dcfce7; color: #15803d; }
.mr-badge.mr-halfday { background: #fef9c3; color: #a16207; }
.mr-badge.mr-absent { background: #fee2e2; color: #dc2626; }
.mr-badge.mr-holiday { background: #dbeafe; color: #1d4ed8; }
.mr-badge.mr-off { background: #e2e8f0; color: #64748b; }
.mr-badge.mr-future { background: #f1f5f9; color: #94a3b8; }

.mr-late { color: #dc2626; font-weight: 600; }
.mr-ontime { color: #15803d; font-weight: 600; }

/* Profile action for My Report */
.profile-action-myreport {
  background: #1e3a5f;
  color: #fff;
}
```

- [ ] **Step 2: Commit**

```bash
git add attendance-frontend/src/App.css
git commit -m "feat: add CSS for Agent View tab and My Report panel"
```

---

## Task 6: End-to-End Verification

- [ ] **Step 1: Start the app** — run backend and frontend:

```bash
# Terminal 1 — backend
cd attendance-frontend/backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — frontend
cd attendance-frontend
npm start
```

- [ ] **Step 2: Test as Employee** — log in as a regular Employee:
  - Profile menu shows "My Report" button
  - My Report panel opens, shows date-wise table for current month
  - Summary KPIs show correct counts
  - Late/On Time badges correct based on 9:30 threshold
  - No download buttons visible anywhere

- [ ] **Step 3: Test as Manager** — log in as a Manager:
  - Profile menu shows "My Report" and "View Reports"
  - My Report works (own data)
  - Reports → Agent View tab available
  - Agent View shows only assigned employees
  - Month filter changes the data
  - No download buttons visible in Reports or Agent View

- [ ] **Step 4: Test as SuperAdmin** — log in as SuperAdmin:
  - My Report works (own data)
  - Reports → Agent View tab available
  - Agent View shows all employees
  - Process/LOB filters work
  - Download Agent View CSV button appears and downloads correctly
  - Adherence tab download buttons still present

- [ ] **Step 5: Final commit** (if any last fixes applied)

```bash
git add -A
git commit -m "fix: end-to-end verification fixes"
```
