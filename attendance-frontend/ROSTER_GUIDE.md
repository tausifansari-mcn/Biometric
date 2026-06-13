# Roster and Shift Planner

## Super Admin Setup

1. Sign in as Super Admin.
2. Open the profile menu.
3. Select **Manage Roster**.
4. Under **Create Shift**, enter:
   - Shift Name: `General 9-7`
   - Start Time: `09:00`
   - End Time: `19:00`
   - Grace Minutes: `15`
   - Break Minutes: `60`
   - Status: `Active`
5. Select **Create Shift**.

This shift is 10 hours long. With a 60-minute break, the report expects
9 productive hours.

## Assign a Roster

1. Search for employees by name or employee code.
2. Select employees, or paste employee codes into **Employee Codes**.
3. Select the From Date and To Date.
4. Select a Day Type:
   - `Working`: requires a shift.
   - `Weekly Off`: excluded from mandate and absence.
   - `Leave`: excluded from mandate and absence.
   - `Holiday`: excluded from mandate and absence.
5. Select the weekdays to update.
6. Select **Assign Roster**.

Existing entries for the same employee and date are updated automatically.
Up to 500 employee codes can be assigned in one operation.

Example employee-code input:

```text
MAS10001, MAS10002
MAS10003
```

## Manager Access

Managers can open **Roster & Shifts**, view available shifts, and assign
rosters only to employees assigned to their manager code. They cannot create
or edit shifts, and the backend blocks assignments outside their team.

## Report Behaviour

- Mandate is the maximum number of agents scheduled to work on a date.
- Late means the first punch is after shift start plus shift grace.
- Present requires the productive minutes defined by shift duration minus break.
- Half Day requires at least half of the productive minutes.
- Weekly Off, Leave, and Holiday roster entries are excluded.
- Dates without a roster continue using the existing default attendance rule.

For a `09:00-19:00` shift with 15-minute grace:

```text
09:14 first punch = On Time
09:16 first punch = Late
```

## Review or Remove

Use **View Assigned Roster** to filter by date or employee. Select **Remove**
to delete one employee-date entry. To change an entry, assign the same
employee and date again with the new day type or shift.
