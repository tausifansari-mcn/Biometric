# Design: Agent View, Employee Personal Report & Download Restrictions
**Date:** 2026-06-15  
**Project:** Biometric Attendance System  
**Status:** Approved

---

## Overview

Three linked features:
1. **Agent View** — Monthly attendance dashboard for managers showing their assigned employees, with columns for Punch In/Out, Login Hours, Process, LOB, Status, Late%, Adherence%. Download locked to SuperAdmin only.
2. **Mandate Fix** — Mandate KPI = count of active Executive employees in scope.
3. **Employee Personal Report** — All employees see their own date-wise late/adherence report (9:30–6:30 shift) via a new "My Report" section.

---

## Feature 1 — Agent View (Manager Monthly Dashboard)

### Access
- **SuperAdmin**: sees all employees; can download CSV.
- **Manager**: sees only their assigned employees (`assign_manager_id` matches their `managar_unique_code`); no download.
- **Admin/Employee**: no access to this view.

### Location
Inside the existing `reports` task (`activeAdminTask === 'reports'`) in `ReportDashboard.js`. Add a toggle/tab at the top: **"Adherence Dashboard" | "Agent View"**.

### UI — Agent View Tab

**Controls:**
- Month picker (`<input type="month">`) defaulting to current month.
- Process filter (dropdown, populated from report data) — SuperAdmin only.
- LOB filter (dropdown) — SuperAdmin only.
- "Download Agent View" button — **visible only when `isSuperAdmin`**.

**Table columns (one row per employee):**

| Column | Source |
|---|---|
| Name | MySQL `EmployeeDetails.EmpName` |
| Emp Code | MySQL `EmployeeDetails.EmpCode` |
| Process | MySQL `EmployeeDetails.process_name` |
| LOB | MySQL `EmployeeDetails.lob_name` |
| Avg Punch In | Avg of `FirstPunchIn` across present days |
| Avg Punch Out | Avg of `LastPunchOut` across present days |
| Total Login Hrs | Sum of `WorkingMinutes` / 60 for the month |
| Present / HD / Absent | Count of each status from daily records |
| Attendance Status | "P" if present ≥ half month days, else "A" (simplified badge) |
| Late% | (Late days / Present days) × 100 |
| Adherence% | (Present full days / Mandate days) × 100 |

**Late rule:** Punch In after 09:30 AM = Late.  
**Full Present:** WorkingMinutes ≥ 540 (9 hours).  
**Half Day:** WorkingMinutes 270–539.  
**Absent:** WorkingMinutes < 270 or no record.

### Backend — New Endpoint

```
GET /api/reports/agent-view?month=YYYY-MM&process_name=&lob_name=
```

**Logic:**
1. Determine scope: SuperAdmin → all active employees; Manager → employees where `assign_manager_id = manager.managar_unique_code`.
2. Fetch attendance from SQL Server for all scoped emp codes for the given month.
3. Join with MySQL employee data (name, process, lob, designation, status).
4. Compute per-employee metrics: avg punch in/out times, total login hours, present/HD/absent counts, late count, adherence%.
5. Compute mandate = count of Active + Executive employees in scope.
6. Return array of employee objects with metrics.

**Response shape:**
```json
{
  "month": "2026-06",
  "mandate": 45,
  "employees": [
    {
      "emp_code": "MAS10001",
      "name": "Riya Sharma",
      "process_name": "Sales",
      "lob_name": "Inbound",
      "manager_name": "Amit Singh",
      "avg_punch_in": "09:28",
      "avg_punch_out": "18:42",
      "total_login_hours": "187:30",
      "present": 18,
      "half_day": 2,
      "absent": 2,
      "late_days": 4,
      "mandate_days": 22,
      "late_percent": 22.2,
      "adherence_percent": 81.8
    }
  ]
}
```

---

## Feature 2 — Mandate KPI in Agent View

The existing `/api/reports/adherence` endpoint keeps its current mandate calculation (peak daily headcount from roster/attendance). The **new Agent View** shows its own Mandate KPI:

**Mandate = `COUNT(*)` from `EmployeeDetails`** where `status = 'Active'` AND `designation = 'Executive'` AND (for Manager scope: `assign_manager_id` matches manager's `managar_unique_code`; for SuperAdmin: no filter unless process/LOB filter applied).

This count is returned in the Agent View API response as a top-level `mandate` field and displayed as a summary KPI card at the top of the Agent View tab.

---

## Feature 3 — Employee Personal Report ("My Report")

### Access
Available to **all logged-in users** (Employee, Manager, Admin, SuperAdmin) — each sees only their own data.

### Location
New `activeAdminTask = 'my_report'` added to `getAllowedTasks()` for all roles. New "My Report" button in profile popup and sidebar Task Center.

### UI

**Header summary cards (for selected month):**
- Total Working Days
- Present Days
- On Time Days
- Late Days
- Adherence% (Present / Working Days × 100)
- Late% (Late Days / Present Days × 100)

**Date-wise table (one row per calendar day):**

| Date | Day | Punch In | Punch Out | Login Hours | Status | Late? | Shift Adherence |
|---|---|---|---|---|---|---|---|
| 01 Jun | Mon | 09:25 | 18:40 | 9:15 | Present | On Time | Met |
| 02 Jun | Tue | 09:45 | 18:30 | 8:45 | Present | Late | Short |
| 03 Jun | Wed | — | — | — | Absent | — | — |

**Definitions:**
- **Shift:** 9:30 AM – 6:30 PM (9 hours)
- **Late:** `FirstPunchIn` time-of-day > 09:30:00
- **Shift Adherence Met:** `WorkingMinutes ≥ 540` (9 hours)
- **Sundays / Holidays:** Shown as "Weekly Off" / "Holiday", not counted as absent

**Month picker:** defaults to current month, allows going back to any past month.

**No new backend endpoint needed** — reuses `GET /api/attendance?month=YYYY-MM` (already scoped to the logged-in user) and `GET /api/holidays?month=YYYY-MM`.

**No download button** — view only for all roles in this personal report.

---

## Download Restriction (Global Rule)

All export/download buttons in `ReportDashboard.js` (Date-wise download, Agent-wise download) and the new Agent View download are conditionally rendered:

```jsx
{isSuperAdmin && <button onClick={downloadXxx}>Download</button>}
```

Managers and below see the same data grids but no download controls.

---

## Files to Change

| File | Change |
|---|---|
| `backend/main.py` | Add `GET /api/reports/agent-view` endpoint; update mandate calculation in adherence endpoint |
| `attendance-frontend/src/App.js` | Add `my_report` to `getAllowedTasks` for all roles; add My Report panel render; add Agent View tab prop to ReportDashboard |
| `attendance-frontend/src/ReportDashboard.js` | Add Agent View tab with month filter + table; gate all download buttons behind `isSuperAdmin` prop |
| `attendance-frontend/src/App.css` | Styles for My Report panel, date table, summary cards |

---

## Constraints

- Agent View month filter scope: cannot query future months.
- Late rule is fixed at 09:30 AM; no shift configuration UI needed in this scope.
- The personal report's "Attendance Status" for Sundays/holidays uses existing `getStatus` logic already in `App.js`.
- Manager's Agent View backend must use the same `assign_manager_id` join pattern already used by support queries.
