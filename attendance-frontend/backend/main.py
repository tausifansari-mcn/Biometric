import base64
import hashlib
import hmac
import os
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Depends, Query, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
import pymssql
try:
    import pyodbc
except ImportError:
    pyodbc = None
import mysql.connector
from mysql.connector import Error as MySQLError
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal, Optional
import jwt

load_dotenv()

app = FastAPI(title="Attendance + Holiday API (Multi-DB)")

# CORS — comma-separated origins from env, e.g. "https://foo.vercel.app,http://localhost:3000"
_default_origins = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://biometric-78e6.vercel.app",
    "https://biometric-b9xd.vercel.app",
)
_raw_origins = os.getenv("CORS_ORIGINS", "")
_configured_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]
CORS_ALLOWED_ORIGINS = list(dict.fromkeys((*_default_origins, *_configured_origins)))

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- JWT Settings ----------
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-me-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 8
PASSWORD_ITERATIONS = 210_000

# ---------- Database Configurations ----------

# 1. Attendance Database (SQL Server)
ATTENDANCE_CONFIG = {
    'server':   os.getenv("SQL_SERVER",   "172.10.10.146"),
    'port':     int(os.getenv("SQL_PORT", "1433")),
    'database': os.getenv("SQL_DATABASE", "NCOSEC"),
    'username': os.getenv("SQL_USER",     "shivamg"),
    'password': os.getenv("SQL_PASSWORD", ""),
    'driver':   os.getenv("SQL_DRIVER",   "{ODBC Driver 17 for SQL Server}"),
}
SQL_CONNECTION_MODE = os.getenv("SQL_CONNECTION_MODE", "pymssql").strip().lower()
SQL_TDS_VERSION = os.getenv("SQL_TDS_VERSION", "7.0")

# 2. Employee/Holiday Database (MySQL)
EMPLOYEE_CONFIG = {
    'host':     os.getenv("MYSQL_HOST",     "122.184.128.90"),
    'port':     int(os.getenv("MYSQL_PORT", "3306")),
    'database': os.getenv("MYSQL_DATABASE", "Shivamgiri"),
    'user':     os.getenv("MYSQL_USER",     "root"),
    'password': os.getenv("MYSQL_PASSWORD", ""),
}

# ---------- Helper: MySQL Connection ----------
def get_mysql_connection():
    """Return a MySQL connection object using mysql.connector."""
    try:
        conn = mysql.connector.connect(**EMPLOYEE_CONFIG)
        return conn
    except MySQLError as e:
        print(f"MySQL connection error: {e}")
        raise HTTPException(status_code=500, detail="Employee database connection failed")

# ---------- Helper: SQL Server Connection ----------
def get_attendance_connection():
    if SQL_CONNECTION_MODE == "pymssql":
        return pymssql.connect(
            server=ATTENDANCE_CONFIG["server"],
            port=str(ATTENDANCE_CONFIG["port"]),
            user=ATTENDANCE_CONFIG["username"],
            password=ATTENDANCE_CONFIG["password"],
            database=ATTENDANCE_CONFIG["database"],
            login_timeout=10,
            timeout=30,
            tds_version=SQL_TDS_VERSION,
        )

    if pyodbc is None:
        raise RuntimeError("pyodbc is not installed; set SQL_CONNECTION_MODE=pymssql")
    conn_str = (
        f"DRIVER={ATTENDANCE_CONFIG['driver']};"
        f"SERVER={ATTENDANCE_CONFIG['server']},{ATTENDANCE_CONFIG['port']};"
        f"DATABASE={ATTENDANCE_CONFIG['database']};"
        f"UID={ATTENDANCE_CONFIG['username']};"
        f"PWD={ATTENDANCE_CONFIG['password']};"
        "TrustServerCertificate=yes;"
        "Encrypt=no;"
    )
    return pyodbc.connect(conn_str)

# ---------- Pydantic Models (same as before) ----------
class LoginRequest(BaseModel):
    emp_code: str
    password: str

class ForgotPasswordRequest(BaseModel):
    emp_code: str
    password: str

class PasswordResetRequestOut(BaseModel):
    id: int
    employee_emp_code: str
    employee_name: str
    manager_emp_code: str
    manager_name: str
    status: str
    created_at: datetime
    reviewed_at: Optional[datetime]
    reviewed_by: Optional[str]

class Token(BaseModel):
    access_token: str
    token_type: str
    emp_code: str
    role: str
    name: str
    designation: str

class ProfileOut(BaseModel):
    emp_code: str
    role: str
    name: str
    designation: str
    is_manager: bool
    process_name: Optional[str] = None
    lob_name: Optional[str] = None

class HolidayCreate(BaseModel):
    holiday_date: str          # YYYY-MM-DD
    reason: str

class HolidayOut(BaseModel):
    id: int
    holiday_date: str
    reason: str
    created_by: Optional[str]

class EmployeeCreate(BaseModel):
    emp_code: str
    emp_name: str
    designation: str = "Executive"
    role: Literal["SuperAdmin", "Admin", "Employee"] = "Employee"
    process_name: str
    lob_name: str
    status: Literal["Active", "Inactive"] = "Active"

class EmployeeUpdate(EmployeeCreate):
    pass

class EmployeeOut(BaseModel):
    id: int
    emp_code: str
    emp_name: str
    designation: str
    role: str
    process_name: Optional[str] = None
    lob_name: Optional[str] = None
    status: Optional[str] = None

class EmployeeBulkCreate(BaseModel):
    employees: list[EmployeeCreate]

class EmployeeBulkOut(BaseModel):
    created_count: int
    employees: list[EmployeeOut]

class ApplicationAccessUpdate(BaseModel):
    status: Literal["Active", "Inactive"]

class ApplicationAccessUserOut(BaseModel):
    emp_code: str
    name: str
    role: str
    source: Literal["Employee", "Manager"]
    status: Literal["Active", "Inactive"]

class ApplicationAccessListOut(BaseModel):
    users: list[ApplicationAccessUserOut]
    active_count: int
    inactive_count: int
    total_count: int

class ManagerCreate(BaseModel):
    manager_empcode: str
    manager_name: str
    process_name: str
    manager_unique_code: str

class ManagerOut(ManagerCreate):
    id: int
    assigned_employee_count: int = 0

class ManagerEmployeeOut(BaseModel):
    id: int
    emp_name: str
    designation: str
    role: str
    emp_code: str
    assigned_manager_unique_code: Optional[str]
    assigned_manager_name: Optional[str]
    process_name: Optional[str] = None
    lob_name: Optional[str] = None

class EmployeeAssignmentRequest(BaseModel):
    employee_ids: list[int]

class ShiftCreate(BaseModel):
    shift_name: str
    start_time: str
    end_time: str
    grace_minutes: int = 15
    break_minutes: int = 60
    status: Literal["Active", "Inactive"] = "Active"

class ShiftOut(ShiftCreate):
    id: int
    is_overnight: bool
    productive_minutes: int

class RosterAssignmentCreate(BaseModel):
    emp_codes: list[str]
    date_from: str
    date_to: str
    day_type: Literal["Working", "WeeklyOff", "Leave", "Holiday"] = "Working"
    shift_id: Optional[int] = None
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5, 6])

class RosterAssignmentOut(BaseModel):
    created_count: int
    updated_count: int
    roster_dates: int
    employee_count: int

class RosterEmployeeOut(BaseModel):
    emp_code: str
    name: str
    process_name: str
    lob_name: str
    manager_name: Optional[str]

class RosterEntryOut(BaseModel):
    id: int
    emp_code: str
    name: str
    roster_date: str
    day_type: str
    shift_id: Optional[int]
    shift_name: Optional[str]
    start_time: Optional[str]
    end_time: Optional[str]
    grace_minutes: Optional[int]
    break_minutes: Optional[int]
    process_name: str
    lob_name: str
    manager_name: Optional[str]
    created_by: str

class AttendanceRecord(BaseModel):
    UserID: str
    Name: str
    Designation: str
    Role: str
    AttendanceDate: str
    FirstPunchIn: str
    LastPunchOut: str
    TotalPunches: int
    WorkingMinutes: int
    WorkingHours: str

class ReportMetric(BaseModel):
    mandate: int
    working_days: int
    planned_agent_days: int
    present: int
    half_day: int
    absent: int
    on_time: int
    late: int
    adherence_percent: float
    shrinkage_percent: float
    on_time_percent: float
    late_percent: float

class ReportLob(BaseModel):
    name: str
    metrics: ReportMetric

class ReportProcess(BaseModel):
    name: str
    metrics: ReportMetric
    lobs: list[ReportLob]

class ReportAgent(BaseModel):
    emp_code: str
    name: str
    process_name: str
    lob_name: str
    manager_name: Optional[str]
    metrics: ReportMetric

class ReportDailyRecord(BaseModel):
    attendance_date: str
    metrics: ReportMetric

class ReportOut(BaseModel):
    scope_label: str
    date_from: str
    date_to: str
    shift_start: str
    late_grace_minutes: int
    shift_rule_label: str
    methodology: str
    overall: ReportMetric
    processes: list[ReportProcess]
    agents: list[ReportAgent]
    agent_count: int
    daily_records: list[ReportDailyRecord]
    process_options: list[str]
    lob_options: list[str]

class SupportQueryOut(BaseModel):
    id: int
    employee_emp_code: str
    employee_name: str
    manager_emp_code: str
    manager_name: str
    query_subject: str
    query_text: str
    status: str
    image_name: Optional[str]
    has_image: bool
    created_at: datetime
    solved_at: Optional[datetime]
    solved_by: Optional[str]

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS
    )
    return "$".join([
        "pbkdf2_sha256",
        str(PASSWORD_ITERATIONS),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii")
    ])

def verify_password(password: str, stored_password: str) -> bool:
    if not stored_password:
        return False
    if not stored_password.startswith("pbkdf2_sha256$"):
        return hmac.compare_digest(password, stored_password)

    try:
        _, iterations, encoded_salt, encoded_digest = stored_password.split("$", 3)
        salt = base64.b64decode(encoded_salt)
        expected_digest = base64.b64decode(encoded_digest)
        actual_digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(iterations)
        )
        return hmac.compare_digest(actual_digest, expected_digest)
    except (TypeError, ValueError):
        return False

def support_query_to_dict(row: dict) -> dict:
    return {
        "id": row["ID"],
        "employee_emp_code": row["EmployeeEmpCode"],
        "employee_name": row["EmployeeName"],
        "manager_emp_code": row["ManagerEmpCode"],
        "manager_name": row["ManagerName"],
        "query_subject": row.get("QuerySubject") or "General Query",
        "query_text": row["QueryText"],
        "status": row["Status"],
        "image_name": row.get("ImageName"),
        "has_image": bool(row.get("HasImage")),
        "created_at": row["CreatedAt"],
        "solved_at": row.get("SolvedAt"),
        "solved_by": row.get("SolvedBy")
    }

def ensure_support_query_subject_column(cursor):
    cursor.execute("SHOW COLUMNS FROM SupportQueries LIKE 'QuerySubject'")
    if not cursor.fetchone():
        cursor.execute(
            """
            ALTER TABLE SupportQueries
            ADD COLUMN QuerySubject VARCHAR(255) NOT NULL DEFAULT 'General Query'
            AFTER ManagerUniqueCode
            """
        )

def ensure_agent_process_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS AgentProcess (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            EmpCode VARCHAR(100) NOT NULL,
            Name VARCHAR(255) NULL,
            `Process` VARCHAR(255) NULL,
            LOBName VARCHAR(255) NULL,
            Status VARCHAR(100) NULL,
            PRIMARY KEY (ID),
            INDEX IX_AgentProcess_EmpCode (EmpCode)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

def ensure_application_access_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS ApplicationAccess (
            EmpCode VARCHAR(100) NOT NULL,
            Status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
            UpdatedBy VARCHAR(100) NOT NULL,
            UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (EmpCode),
            INDEX IX_ApplicationAccess_Status (Status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

def get_application_access_status(cursor, emp_code: str) -> str:
    ensure_application_access_table(cursor)
    cursor.execute(
        """
        SELECT Status
        FROM ApplicationAccess
        WHERE UPPER(EmpCode) = UPPER(%s)
        """,
        (emp_code,)
    )
    row = cursor.fetchone()
    if not row:
        return "Active"
    if isinstance(row, dict):
        return row.get("Status") or "Active"
    return row[0] or "Active"

def upsert_application_access(
    cursor,
    emp_code: str,
    status: str,
    updated_by: str
):
    ensure_application_access_table(cursor)
    cursor.execute(
        """
        INSERT INTO ApplicationAccess (EmpCode, Status, UpdatedBy)
        VALUES (%s, %s, %s)
        ON DUPLICATE KEY UPDATE
            Status = VALUES(Status),
            UpdatedBy = VALUES(UpdatedBy)
        """,
        (emp_code.strip().upper(), status, updated_by.strip().upper())
    )

def ensure_roster_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS Shifts (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            ShiftName VARCHAR(150) NOT NULL,
            StartTime TIME NOT NULL,
            EndTime TIME NOT NULL,
            GraceMinutes INT NOT NULL DEFAULT 15,
            BreakMinutes INT NOT NULL DEFAULT 60,
            Status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
            CreatedBy VARCHAR(100) NOT NULL,
            CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY UX_Shifts_Name (ShiftName)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS EmployeeRoster (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            EmpCode VARCHAR(100) NOT NULL,
            RosterDate DATE NOT NULL,
            ShiftID BIGINT UNSIGNED NULL,
            DayType ENUM('Working', 'WeeklyOff', 'Leave', 'Holiday')
                NOT NULL DEFAULT 'Working',
            ProcessName VARCHAR(255) NULL,
            LOBName VARCHAR(255) NULL,
            CreatedBy VARCHAR(100) NOT NULL,
            CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY UX_EmployeeRoster_EmpDate (EmpCode, RosterDate),
            INDEX IX_EmployeeRoster_Date (RosterDate),
            INDEX IX_EmployeeRoster_Shift (ShiftID),
            CONSTRAINT FK_EmployeeRoster_Shift
                FOREIGN KEY (ShiftID) REFERENCES Shifts(ID)
                ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

def parse_time_value(value: str, field_name: str) -> time:
    try:
        return datetime.strptime(value.strip(), "%H:%M").time()
    except (AttributeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must use 24-hour HH:MM format"
        )

def shift_duration_minutes(start_time: time, end_time: time) -> int:
    start_minutes = start_time.hour * 60 + start_time.minute
    end_minutes = end_time.hour * 60 + end_time.minute
    duration = end_minutes - start_minutes
    return duration if duration > 0 else duration + (24 * 60)

def database_time_value(value) -> time:
    if isinstance(value, time):
        return value
    if isinstance(value, timedelta):
        total_minutes = int(value.total_seconds() // 60) % (24 * 60)
        return time(total_minutes // 60, total_minutes % 60)
    try:
        parts = str(value).split(":")
        return time(int(parts[0]) % 24, int(parts[1]))
    except (TypeError, ValueError, IndexError):
        raise HTTPException(status_code=500, detail="Invalid shift time stored in database")

def database_time_text(value) -> str:
    return database_time_value(value).strftime("%H:%M")

def shift_to_dict(row: dict) -> dict:
    start_time = database_time_value(row["StartTime"])
    end_time = database_time_value(row["EndTime"])
    start_text = start_time.strftime("%H:%M")
    end_text = end_time.strftime("%H:%M")
    duration = shift_duration_minutes(start_time, end_time)
    break_minutes = int(row.get("BreakMinutes") or 0)
    return {
        "id": row["ID"],
        "shift_name": row["ShiftName"],
        "start_time": start_text,
        "end_time": end_text,
        "grace_minutes": int(row.get("GraceMinutes") or 0),
        "break_minutes": break_minutes,
        "status": row.get("Status") or "Active",
        "is_overnight": end_time <= start_time,
        "productive_minutes": max(duration - break_minutes, 1)
    }

def get_agent_process_for_user(cursor, emp_code: str):
    ensure_agent_process_table(cursor)
    cursor.execute(
        """
        SELECT `Process`, LOBName
        FROM AgentProcess
        WHERE UPPER(EmpCode) = UPPER(%s)
        ORDER BY ID DESC
        LIMIT 1
        """,
        (emp_code,)
    )
    return cursor.fetchone()

def normalize_employee(employee: EmployeeCreate) -> dict:
    values = {
        "emp_code": employee.emp_code.strip().upper(),
        "emp_name": employee.emp_name.strip(),
        "designation": employee.designation.strip() or "Executive",
        "role": employee.role,
        "process_name": employee.process_name.strip(),
        "lob_name": employee.lob_name.strip(),
        "status": employee.status
    }
    required_fields = (
        values["emp_code"],
        values["emp_name"],
        values["process_name"],
        values["lob_name"]
    )
    if not all(required_fields):
        raise HTTPException(
            status_code=400,
            detail="Employee Code, Employee Name, Process, and LOBName are required"
        )
    return values

def upsert_agent_process(cursor, employee: dict, previous_emp_code: Optional[str] = None):
    ensure_agent_process_table(cursor)
    emp_codes = [employee["emp_code"]]
    if previous_emp_code and previous_emp_code.upper() != employee["emp_code"]:
        emp_codes.append(previous_emp_code.upper())

    placeholders = ",".join(["%s"] * len(emp_codes))
    cursor.execute(
        f"""
        SELECT ID
        FROM AgentProcess
        WHERE UPPER(EmpCode) IN ({placeholders})
        LIMIT 1
        """,
        tuple(emp_codes)
    )
    if cursor.fetchone():
        cursor.execute(
            f"""
            UPDATE AgentProcess
            SET EmpCode = %s, Name = %s, `Process` = %s, LOBName = %s
            WHERE UPPER(EmpCode) IN ({placeholders})
            """,
            tuple([
                employee["emp_code"],
                employee["emp_name"],
                employee["process_name"],
                employee["lob_name"],
                *emp_codes
            ])
        )
        return

    cursor.execute(
        """
        INSERT INTO AgentProcess (EmpCode, Name, `Process`, LOBName, Status)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (
            employee["emp_code"],
            employee["emp_name"],
            employee["process_name"],
            employee["lob_name"],
            "Active"
        )
    )

def insert_employee_rows(cursor, employee: dict, updated_by: str) -> dict:
    cursor.execute(
        """
        INSERT INTO EmployeeDetails (EmpName, Designation, Role, EmpCode)
        VALUES (%s, %s, %s, %s)
        """,
        (
            employee["emp_name"],
            employee["designation"],
            employee["role"],
            employee["emp_code"]
        )
    )
    employee_id = cursor.lastrowid
    upsert_agent_process(cursor, employee)
    upsert_application_access(
        cursor,
        employee["emp_code"],
        employee["status"],
        updated_by
    )
    return {"id": employee_id, **employee}

def ensure_password_reset_requests_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS PasswordResetRequests (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            EmployeeID BIGINT NOT NULL,
            EmployeeEmpCode VARCHAR(100) NOT NULL,
            EmployeeName VARCHAR(255) NOT NULL,
            ManagerID BIGINT NOT NULL,
            ManagerEmpCode VARCHAR(100) NOT NULL,
            ManagerName VARCHAR(255) NOT NULL,
            ManagerUniqueCode VARCHAR(255) NOT NULL,
            ProposedPasswordHash VARCHAR(512) NOT NULL,
            Status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
            CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ReviewedAt DATETIME NULL,
            ReviewedBy VARCHAR(100) NULL,
            PRIMARY KEY (ID),
            INDEX IX_PasswordResetRequests_Employee (EmployeeEmpCode, CreatedAt),
            INDEX IX_PasswordResetRequests_Manager (ManagerID, Status, CreatedAt)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
    )

def password_reset_request_to_dict(row: dict) -> dict:
    return {
        "id": row["ID"],
        "employee_emp_code": row["EmployeeEmpCode"],
        "employee_name": row["EmployeeName"],
        "manager_emp_code": row["ManagerEmpCode"],
        "manager_name": row["ManagerName"],
        "status": row["Status"],
        "created_at": row["CreatedAt"],
        "reviewed_at": row.get("ReviewedAt"),
        "reviewed_by": row.get("ReviewedBy")
    }

def get_manager_for_user(cursor, emp_code: str):
    cursor.execute(
        """
        SELECT ID, Manager_empcode, Manager_Name, Process_name, managar_unique_code
        FROM Managers
        WHERE UPPER(Manager_empcode) = UPPER(%s)
        """,
        (emp_code,)
    )
    return cursor.fetchone()

def empty_report_metric(
    mandate: int,
    working_days: int,
    planned_agent_days: Optional[int] = None
) -> dict:
    return {
        "mandate": mandate,
        "working_days": working_days,
        "planned_agent_days": (
            mandate * working_days
            if planned_agent_days is None
            else planned_agent_days
        ),
        "present": 0,
        "half_day": 0,
        "absent": 0,
        "on_time": 0,
        "late": 0,
        "adherence_percent": 0.0,
        "shrinkage_percent": 0.0,
        "on_time_percent": 0.0,
        "late_percent": 0.0
    }

def finalize_report_metric(metric: dict) -> dict:
    planned = metric["planned_agent_days"]
    attended = metric["on_time"] + metric["late"]
    adhered_days = metric["present"] + (metric["half_day"] * 0.5)
    metric["adherence_percent"] = round(
        (adhered_days / planned * 100) if planned else 0,
        1
    )
    metric["shrinkage_percent"] = round(
        (max(planned - adhered_days, 0) / planned * 100) if planned else 0,
        1
    )
    metric["on_time_percent"] = round(
        (metric["on_time"] / attended * 100) if attended else 0,
        1
    )
    metric["late_percent"] = round(
        (metric["late"] / attended * 100) if attended else 0,
        1
    )
    return metric

def add_report_day(metric: dict, status: str, punctuality: str):
    if status == "Present":
        metric["present"] += 1
    elif status == "Half Day":
        metric["half_day"] += 1
    else:
        metric["absent"] += 1

    if punctuality == "On Time":
        metric["on_time"] += 1
    elif punctuality == "Late":
        metric["late"] += 1

# ---------- JWT Functions (unchanged) ----------
def create_access_token(emp_code: str, role: str):
    payload = {
        "sub": emp_code,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        emp_code = payload.get("sub")
        role = payload.get("role")
        if not emp_code:
            raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT Role
            FROM EmployeeDetails
            WHERE UPPER(EmpCode) = UPPER(%s)
            LIMIT 1
            """,
            (emp_code,)
        )
        employee = cursor.fetchone()
        manager = None
        if not employee:
            manager = get_manager_for_user(cursor, emp_code)
        if not employee and not manager:
            raise HTTPException(status_code=401, detail="Account no longer exists")

        status = get_application_access_status(cursor, emp_code)
        if status.lower() != "active":
            raise HTTPException(
                status_code=403,
                detail="Application access is inactive. Contact your Super Admin."
            )

        current_role = employee["Role"] if employee else "Manager"
        return {"emp_code": emp_code, "role": current_role or role}
    finally:
        cursor.close()
        conn.close()

# ---------- API Endpoints ----------

@app.get("/")
def root():
    return {"message": "Attendance API is running"}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/api/login", response_model=Token)
def login(request: LoginRequest):
    """
    Authenticate employee using the MySQL database (EmployeeDetails table).
    Use the saved password when present; otherwise use emp_code + "@123".
    """
    emp_code = request.emp_code.strip().upper()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    access_status = get_application_access_status(cursor, emp_code)
    if access_status.lower() != "active":
        cursor.close()
        conn.close()
        raise HTTPException(
            status_code=403,
            detail="Application access is inactive. Contact your Super Admin."
        )
    cursor.execute(
        """
        SELECT EmpName, Role, Designation, Password
        FROM EmployeeDetails
        WHERE EmpCode = %s
        """,
        (emp_code,)
    )
    row = cursor.fetchone()

    if not row:
        manager = get_manager_for_user(cursor, emp_code)
        cursor.close()
        conn.close()
        if not manager or not hmac.compare_digest(request.password, f"{emp_code}@123"):
            raise HTTPException(status_code=401, detail="Invalid credentials")

        role = "Manager"
        token = create_access_token(emp_code, role)
        return {
            "access_token": token,
            "token_type": "bearer",
            "emp_code": emp_code,
            "role": role,
            "name": manager.get("Manager_Name") or "Manager",
            "designation": manager.get("Process_name") or "Manager"
        }

    cursor.close()
    conn.close()

    emp_name, role = row["EmpName"], row["Role"]
    designation = row["Designation"]
    saved_password = row.get("Password")
    password_is_valid = (
        verify_password(request.password, saved_password)
        if saved_password
        else hmac.compare_digest(request.password, f"{emp_code}@123")
    )
    if not password_is_valid:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(emp_code, role)
    return {
        "access_token": token,
        "token_type": "bearer",
        "emp_code": emp_code,
        "role": role,
        "name": emp_name,
        "designation": designation
    }

@app.post("/api/forgot-password")
def forgot_password(request: ForgotPasswordRequest):
    """Create a password reset request for the employee's assigned manager."""
    emp_code = request.emp_code.strip().upper()
    if not emp_code:
        raise HTTPException(status_code=400, detail="Employee code is required")
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_password_reset_requests_table(cursor)
        if get_application_access_status(cursor, emp_code).lower() != "active":
            raise HTTPException(
                status_code=403,
                detail="Application access is inactive. Contact your Super Admin."
            )
        cursor.execute(
            """
            SELECT
                e.ID AS EmployeeID,
                e.EmpCode,
                e.EmpName,
                m.ID AS ManagerID,
                m.Manager_empcode,
                m.Manager_Name,
                m.managar_unique_code
            FROM EmployeeDetails e
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE UPPER(e.EmpCode) = UPPER(%s)
            """,
            (emp_code,)
        )
        assignment = cursor.fetchone()
        if not assignment:
            raise HTTPException(status_code=404, detail="Employee code not found")
        if not assignment.get("ManagerID"):
            raise HTTPException(
                status_code=400,
                detail="No manager is assigned to this employee"
            )

        proposed_password_hash = hash_password(request.password)
        cursor.execute(
            """
            SELECT ID
            FROM PasswordResetRequests
            WHERE EmployeeID = %s AND Status = 'Pending'
            ORDER BY CreatedAt DESC
            LIMIT 1
            """,
            (assignment["EmployeeID"],)
        )
        pending_request = cursor.fetchone()
        if pending_request:
            request_id = pending_request["ID"]
            cursor.execute(
                """
                UPDATE PasswordResetRequests
                SET
                    ManagerID = %s,
                    ManagerEmpCode = %s,
                    ManagerName = %s,
                    ManagerUniqueCode = %s,
                    ProposedPasswordHash = %s,
                    CreatedAt = CURRENT_TIMESTAMP,
                    ReviewedAt = NULL,
                    ReviewedBy = NULL
                WHERE ID = %s
                """,
                (
                    assignment["ManagerID"],
                    assignment["Manager_empcode"],
                    assignment["Manager_Name"],
                    assignment["managar_unique_code"],
                    proposed_password_hash,
                    request_id
                )
            )
        else:
            cursor.execute(
                """
                INSERT INTO PasswordResetRequests (
                    EmployeeID, EmployeeEmpCode, EmployeeName,
                    ManagerID, ManagerEmpCode, ManagerName, ManagerUniqueCode,
                    ProposedPasswordHash
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    assignment["EmployeeID"],
                    assignment["EmpCode"],
                    assignment["EmpName"],
                    assignment["ManagerID"],
                    assignment["Manager_empcode"],
                    assignment["Manager_Name"],
                    assignment["managar_unique_code"],
                    proposed_password_hash
                )
            )
            request_id = cursor.lastrowid

        conn.commit()
        return {
            "message": (
                f"Password reset request sent to {assignment['Manager_Name']}. "
                "You can use the new password after approval."
            ),
            "request_id": request_id,
            "manager_name": assignment["Manager_Name"],
            "status": "Pending"
        }
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to request password reset: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get(
    "/api/manager/password-reset-requests",
    response_model=list[PasswordResetRequestOut]
)
def get_manager_password_reset_requests(
    current_user: dict = Depends(get_current_user)
):
    """List password reset requests for the assigned manager or SuperAdmin."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_password_reset_requests_table(cursor)
        role = str(current_user.get("role", "")).lower()
        if role == "superadmin":
            cursor.execute(
                """
                SELECT
                    ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                    Status, CreatedAt, ReviewedAt, ReviewedBy
                FROM PasswordResetRequests
                ORDER BY CASE WHEN Status = 'Pending' THEN 0 ELSE 1 END, CreatedAt DESC
                """
            )
        else:
            manager = get_manager_for_user(cursor, current_user["emp_code"])
            if not manager:
                raise HTTPException(
                    status_code=403,
                    detail="Password reset approval access required"
                )
            cursor.execute(
                """
                SELECT
                    ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                    Status, CreatedAt, ReviewedAt, ReviewedBy
                FROM PasswordResetRequests
                WHERE ManagerID = %s
                ORDER BY CASE WHEN Status = 'Pending' THEN 0 ELSE 1 END, CreatedAt DESC
                """,
                (manager["ID"],)
            )
        return [password_reset_request_to_dict(row) for row in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()

def review_password_reset_request(
    request_id: int,
    decision: Literal["Approved", "Rejected"],
    current_user: dict
):
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_password_reset_requests_table(cursor)
        cursor.execute(
            """
            SELECT *
            FROM PasswordResetRequests
            WHERE ID = %s
            FOR UPDATE
            """,
            (request_id,)
        )
        reset_request = cursor.fetchone()
        if not reset_request:
            raise HTTPException(status_code=404, detail="Password reset request not found")

        role = str(current_user.get("role", "")).lower()
        if role != "superadmin":
            manager = get_manager_for_user(cursor, current_user["emp_code"])
            if not manager or manager["ID"] != reset_request["ManagerID"]:
                raise HTTPException(
                    status_code=403,
                    detail="You cannot review this password reset request"
                )

        if reset_request["Status"] != "Pending":
            raise HTTPException(
                status_code=400,
                detail=f"Password reset request is already {reset_request['Status'].lower()}"
            )

        if decision == "Approved":
            cursor.execute(
                """
                UPDATE EmployeeDetails
                SET Password = %s
                WHERE ID = %s AND UPPER(EmpCode) = UPPER(%s)
                """,
                (
                    reset_request["ProposedPasswordHash"],
                    reset_request["EmployeeID"],
                    reset_request["EmployeeEmpCode"]
                )
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Employee account not found")

        cursor.execute(
            """
            UPDATE PasswordResetRequests
            SET Status = %s, ReviewedAt = CURRENT_TIMESTAMP, ReviewedBy = %s
            WHERE ID = %s AND Status = 'Pending'
            """,
            (decision, current_user["emp_code"], request_id)
        )
        conn.commit()
        cursor.execute(
            """
            SELECT
                ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                Status, CreatedAt, ReviewedAt, ReviewedBy
            FROM PasswordResetRequests
            WHERE ID = %s
            """,
            (request_id,)
        )
        return password_reset_request_to_dict(cursor.fetchone())
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to review password reset: {error}")
    finally:
        cursor.close()
        conn.close()

@app.patch(
    "/api/manager/password-reset-requests/{request_id}/approve",
    response_model=PasswordResetRequestOut
)
def approve_password_reset_request(
    request_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Approve a request and activate the employee's proposed password."""
    return review_password_reset_request(request_id, "Approved", current_user)

@app.patch(
    "/api/manager/password-reset-requests/{request_id}/reject",
    response_model=PasswordResetRequestOut
)
def reject_password_reset_request(
    request_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Reject a request without changing the employee's password."""
    return review_password_reset_request(request_id, "Rejected", current_user)

@app.get("/api/profile", response_model=ProfileOut)
def get_profile(current_user: dict = Depends(get_current_user)):
    """Return details for the signed-in employee's profile popup."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        "SELECT EmpName, Role, Designation FROM EmployeeDetails WHERE EmpCode = %s",
        (current_user["emp_code"],)
    )
    row = cursor.fetchone()
    manager = get_manager_for_user(cursor, current_user["emp_code"])
    agent_process = get_agent_process_for_user(cursor, current_user["emp_code"])
    cursor.close()
    conn.close()

    if not row and not manager:
        raise HTTPException(status_code=404, detail="Employee not found")

    if not row:
        return {
            "emp_code": current_user["emp_code"],
            "role": "Manager",
            "name": manager.get("Manager_Name") or "Manager",
            "designation": manager.get("Process_name") or "Manager",
            "is_manager": True,
            "process_name": agent_process.get("Process") if agent_process else None,
            "lob_name": agent_process.get("LOBName") if agent_process else None
        }

    return {
        "emp_code": current_user["emp_code"],
        "role": row.get("Role") or current_user.get("role") or "User",
        "name": row.get("EmpName") or "Employee",
        "designation": row["Designation"],
        "is_manager": manager is not None,
        "process_name": agent_process.get("Process") if agent_process else None,
        "lob_name": agent_process.get("LOBName") if agent_process else None
    }

@app.get("/api/application-access", response_model=ApplicationAccessListOut)
def get_application_access_users(
    search: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=500),
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: list employee and manager application access."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    cleaned_search = (search or "").strip()
    search_pattern = f"%{cleaned_search}%"
    identities_sql = """
        SELECT
            e.EmpCode AS EmpCode,
            e.EmpName AS Name,
            e.Role AS Role,
            'Employee' AS Source
        FROM EmployeeDetails e
        UNION ALL
        SELECT
            m.Manager_empcode AS EmpCode,
            m.Manager_Name AS Name,
            'Manager' AS Role,
            'Manager' AS Source
        FROM Managers m
        WHERE NOT EXISTS (
            SELECT 1
            FROM EmployeeDetails e
            WHERE UPPER(e.EmpCode) = UPPER(m.Manager_empcode)
        )
    """

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_application_access_table(cursor)
        cursor.execute(
            f"""
            SELECT
                identities.EmpCode,
                identities.Name,
                identities.Role,
                identities.Source,
                COALESCE(aa.Status, 'Active') AS AccessStatus
            FROM ({identities_sql}) identities
            LEFT JOIN ApplicationAccess aa
                ON BINARY aa.EmpCode = BINARY identities.EmpCode
            WHERE (
                %s = ''
                OR identities.EmpCode LIKE %s
                OR identities.Name LIKE %s
                OR identities.Role LIKE %s
            )
            ORDER BY
                CASE COALESCE(aa.Status, 'Active')
                    WHEN 'Inactive' THEN 0 ELSE 1
                END,
                identities.Name,
                identities.EmpCode
            LIMIT %s
            """,
            (
                cleaned_search,
                search_pattern,
                search_pattern,
                search_pattern,
                limit
            )
        )
        rows = cursor.fetchall()

        cursor.execute(
            f"""
            SELECT
                COUNT(*) AS TotalCount,
                SUM(
                    CASE WHEN COALESCE(aa.Status, 'Active') = 'Active'
                    THEN 1 ELSE 0 END
                ) AS ActiveCount,
                SUM(
                    CASE WHEN COALESCE(aa.Status, 'Active') = 'Inactive'
                    THEN 1 ELSE 0 END
                ) AS InactiveCount
            FROM ({identities_sql}) identities
            LEFT JOIN ApplicationAccess aa
                ON BINARY aa.EmpCode = BINARY identities.EmpCode
            """
        )
        totals = cursor.fetchone()
        return {
            "users": [
                {
                    "emp_code": row["EmpCode"],
                    "name": row["Name"],
                    "role": row["Role"] or "Employee",
                    "source": row["Source"],
                    "status": row["AccessStatus"]
                }
                for row in rows
            ],
            "active_count": int(totals["ActiveCount"] or 0),
            "inactive_count": int(totals["InactiveCount"] or 0),
            "total_count": int(totals["TotalCount"] or 0)
        }
    finally:
        cursor.close()
        conn.close()

@app.put(
    "/api/application-access/{emp_code}",
    response_model=ApplicationAccessUserOut
)
def update_application_access(
    emp_code: str,
    access: ApplicationAccessUpdate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: activate or deactivate an application account."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    normalized_emp_code = emp_code.strip().upper()
    if (
        normalized_emp_code == current_user["emp_code"].upper()
        and access.status == "Inactive"
    ):
        raise HTTPException(
            status_code=400,
            detail="You cannot deactivate your own application access"
        )

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT EmpCode, EmpName AS Name, Role
            FROM EmployeeDetails
            WHERE UPPER(EmpCode) = UPPER(%s)
            LIMIT 1
            """,
            (normalized_emp_code,)
        )
        identity = cursor.fetchone()
        source = "Employee"
        if not identity:
            cursor.execute(
                """
                SELECT
                    Manager_empcode AS EmpCode,
                    Manager_Name AS Name,
                    'Manager' AS Role
                FROM Managers
                WHERE UPPER(Manager_empcode) = UPPER(%s)
                LIMIT 1
                """,
                (normalized_emp_code,)
            )
            identity = cursor.fetchone()
            source = "Manager"
        if not identity:
            raise HTTPException(status_code=404, detail="Application account not found")

        if str(identity["Role"]).lower() == "superadmin" and access.status == "Inactive":
            cursor.execute(
                """
                SELECT COUNT(*) AS ActiveSuperAdmins
                FROM EmployeeDetails e
                LEFT JOIN ApplicationAccess aa
                    ON BINARY aa.EmpCode = BINARY e.EmpCode
                WHERE LOWER(e.Role) = 'superadmin'
                  AND UPPER(e.EmpCode) <> UPPER(%s)
                  AND COALESCE(aa.Status, 'Active') = 'Active'
                """,
                (normalized_emp_code,)
            )
            if int(cursor.fetchone()["ActiveSuperAdmins"] or 0) == 0:
                raise HTTPException(
                    status_code=400,
                    detail="At least one active Super Admin account is required"
                )

        upsert_application_access(
            cursor,
            normalized_emp_code,
            access.status,
            current_user["emp_code"]
        )
        conn.commit()
        return {
            "emp_code": identity["EmpCode"],
            "name": identity["Name"],
            "role": identity["Role"] or "Employee",
            "source": source,
            "status": access.status
        }
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.post("/api/support-queries", response_model=SupportQueryOut, status_code=201)
async def create_support_query(
    query_subject: str = Form(...),
    query_text: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user)
):
    """Create a query for the employee's assigned manager."""
    cleaned_subject = query_subject.strip()
    cleaned_query = query_text.strip()
    if not cleaned_subject:
        raise HTTPException(status_code=400, detail="Query subject is required")
    if len(cleaned_subject) > 255:
        raise HTTPException(status_code=400, detail="Query subject cannot exceed 255 characters")
    if not cleaned_query:
        raise HTTPException(status_code=400, detail="Query is required")
    if len(cleaned_query) > 5000:
        raise HTTPException(status_code=400, detail="Query cannot exceed 5000 characters")

    image_data = None
    image_name = None
    image_type = None
    if image and image.filename:
        if not image.content_type or not image.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Attachment must be an image")
        image_data = await image.read(5 * 1024 * 1024 + 1)
        if len(image_data) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Image cannot exceed 5 MB")
        image_name = image.filename[:255]
        image_type = image.content_type[:100]

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_support_query_subject_column(cursor)
        cursor.execute(
            """
            SELECT
                e.ID AS EmployeeID,
                e.EmpCode,
                e.EmpName,
                m.ID AS ManagerID,
                m.Manager_empcode,
                m.Manager_Name,
                m.managar_unique_code
            FROM EmployeeDetails e
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE UPPER(e.EmpCode) = UPPER(%s)
            """,
            (current_user["emp_code"],)
        )
        assignment = cursor.fetchone()
        if not assignment:
            raise HTTPException(status_code=404, detail="Employee not found")
        if not assignment.get("ManagerID"):
            raise HTTPException(status_code=400, detail="No manager is assigned to this employee")

        cursor.execute(
            """
            INSERT INTO SupportQueries (
                EmployeeID, EmployeeEmpCode, EmployeeName,
                ManagerID, ManagerEmpCode, ManagerName, ManagerUniqueCode,
                QuerySubject, QueryText, ImageData, ImageName, ImageMimeType
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                assignment["EmployeeID"],
                assignment["EmpCode"],
                assignment["EmpName"],
                assignment["ManagerID"],
                assignment["Manager_empcode"],
                assignment["Manager_Name"],
                assignment["managar_unique_code"],
                cleaned_subject,
                cleaned_query,
                image_data,
                image_name,
                image_type
            )
        )
        query_id = cursor.lastrowid
        conn.commit()
        cursor.execute(
            """
            SELECT *, ImageData IS NOT NULL AS HasImage
            FROM SupportQueries
            WHERE ID = %s
            """,
            (query_id,)
        )
        return support_query_to_dict(cursor.fetchone())
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to send query: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/support-queries", response_model=list[SupportQueryOut])
def get_employee_support_queries(current_user: dict = Depends(get_current_user)):
    """List queries created by the signed-in employee."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_support_query_subject_column(cursor)
        cursor.execute(
            """
            SELECT
                ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                QuerySubject, QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
                CreatedAt, SolvedAt, SolvedBy
            FROM SupportQueries
            WHERE UPPER(EmployeeEmpCode) = UPPER(%s)
            ORDER BY CreatedAt DESC
            """,
            (current_user["emp_code"],)
        )
        return [support_query_to_dict(row) for row in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()

@app.get("/api/manager/support-queries", response_model=list[SupportQueryOut])
def get_manager_support_queries(current_user: dict = Depends(get_current_user)):
    """List queries available to managers and administrators."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_support_query_subject_column(cursor)
        role = str(current_user.get("role", "")).lower()
        if role in ("admin", "superadmin"):
            cursor.execute(
                """
                SELECT
                    ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                    QuerySubject, QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
                    CreatedAt, SolvedAt, SolvedBy
                FROM SupportQueries
                ORDER BY CASE WHEN Status = 'Open' THEN 0 ELSE 1 END, CreatedAt DESC
                """
            )
        else:
            manager = get_manager_for_user(cursor, current_user["emp_code"])
            if not manager:
                raise HTTPException(status_code=403, detail="Query bucket access required")
            cursor.execute(
                """
                SELECT
                    ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                    QuerySubject, QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
                    CreatedAt, SolvedAt, SolvedBy
                FROM SupportQueries
                WHERE ManagerID = %s
                ORDER BY CASE WHEN Status = 'Open' THEN 0 ELSE 1 END, CreatedAt DESC
                """,
                (manager["ID"],)
            )
        return [support_query_to_dict(row) for row in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()

@app.patch("/api/manager/support-queries/{query_id}/solve", response_model=SupportQueryOut)
def solve_support_query(
    query_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Mark an employee query as solved from the shared task center."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_support_query_subject_column(cursor)
        role = str(current_user.get("role", "")).lower()
        if role in ("admin", "superadmin"):
            cursor.execute(
                """
                UPDATE SupportQueries
                SET Status = 'Solved', SolvedAt = CURRENT_TIMESTAMP, SolvedBy = %s
                WHERE ID = %s AND Status = 'Open'
                """,
                (current_user["emp_code"], query_id)
            )
        else:
            manager = get_manager_for_user(cursor, current_user["emp_code"])
            if not manager:
                raise HTTPException(status_code=403, detail="Query bucket access required")
            cursor.execute(
                """
                UPDATE SupportQueries
                SET Status = 'Solved', SolvedAt = CURRENT_TIMESTAMP, SolvedBy = %s
                WHERE ID = %s AND ManagerID = %s AND Status = 'Open'
                """,
                (current_user["emp_code"], query_id, manager["ID"])
            )
        if cursor.rowcount == 0:
            if role in ("admin", "superadmin"):
                cursor.execute("SELECT ID FROM SupportQueries WHERE ID = %s", (query_id,))
            else:
                cursor.execute(
                    "SELECT ID FROM SupportQueries WHERE ID = %s AND ManagerID = %s",
                    (query_id, manager["ID"])
                )
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Query not found")
        conn.commit()
        cursor.execute(
            """
            SELECT *, ImageData IS NOT NULL AS HasImage
            FROM SupportQueries
            WHERE ID = %s
            """,
            (query_id,)
        )
        return support_query_to_dict(cursor.fetchone())
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.get("/api/support-queries/{query_id}/image")
def get_support_query_image(
    query_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Return an attached image to an authenticated task-center user."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT EmployeeEmpCode, ManagerID, ImageData, ImageName, ImageMimeType
            FROM SupportQueries
            WHERE ID = %s
            """,
            (query_id,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Query not found")

        role = str(current_user.get("role", "")).lower()
        is_employee = row["EmployeeEmpCode"].upper() == current_user["emp_code"].upper()
        manager = None if is_employee else get_manager_for_user(cursor, current_user["emp_code"])
        is_assigned_manager = bool(manager and manager["ID"] == row["ManagerID"])
        if not is_employee and not is_assigned_manager and role not in ("admin", "superadmin"):
            raise HTTPException(status_code=403, detail="You cannot view this attachment")
        if not row.get("ImageData"):
            raise HTTPException(status_code=404, detail="No image is attached")

        safe_name = (row.get("ImageName") or "support-image").replace('"', "")
        return Response(
            content=row["ImageData"],
            media_type=row.get("ImageMimeType") or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{safe_name}"'}
        )
    finally:
        cursor.close()
        conn.close()

@app.post("/api/managers", response_model=ManagerOut, status_code=201)
def create_manager(
    manager: ManagerCreate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: add a row to the Managers table."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    manager_empcode = manager.manager_empcode.strip().upper()
    manager_name = manager.manager_name.strip()
    process_name = manager.process_name.strip()
    manager_unique_code = manager.manager_unique_code.strip().upper()
    if not manager_empcode or not manager_name or not process_name or not manager_unique_code:
        raise HTTPException(status_code=400, detail="All manager fields are required")

    conn = get_mysql_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO Managers (
                Manager_empcode, Manager_Name, Process_name, managar_unique_code
            )
            VALUES (%s, %s, %s, %s)
            """,
            (manager_empcode, manager_name, process_name, manager_unique_code)
        )
        conn.commit()
        return {
            "id": cursor.lastrowid,
            "manager_empcode": manager_empcode,
            "manager_name": manager_name,
            "process_name": process_name,
            "manager_unique_code": manager_unique_code
        }
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="Manager employee code or unique code already exists"
        )
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to add manager: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/managers", response_model=list[ManagerOut])
def get_managers(current_user: dict = Depends(get_current_user)):
    """SuperAdmin only: list rows from the Managers table."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT
                m.*,
                (
                    SELECT COUNT(*)
                    FROM EmployeeDetails e
                    WHERE e.assign_manager_id = m.managar_unique_code
                ) AS assigned_employee_count
            FROM Managers m
            ORDER BY m.Manager_Name, m.ID
            """
        )
        return [
            {
                "id": row["ID"],
                "manager_empcode": row["Manager_empcode"],
                "manager_name": row["Manager_Name"],
                "process_name": row["Process_name"],
                "manager_unique_code": row["managar_unique_code"],
                "assigned_employee_count": row["assigned_employee_count"]
            }
            for row in cursor.fetchall()
        ]
    finally:
        cursor.close()
        conn.close()

@app.put("/api/managers/{manager_id}", response_model=ManagerOut)
def update_manager(
    manager_id: int,
    manager: ManagerCreate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: update a Managers row."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    manager_empcode = manager.manager_empcode.strip().upper()
    manager_name = manager.manager_name.strip()
    process_name = manager.process_name.strip()
    manager_unique_code = manager.manager_unique_code.strip().upper()
    if not manager_empcode or not manager_name or not process_name or not manager_unique_code:
        raise HTTPException(status_code=400, detail="All manager fields are required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            UPDATE Managers
            SET Manager_empcode = %s, Manager_Name = %s,
                Process_name = %s, managar_unique_code = %s
            WHERE ID = %s
            """,
            (
                manager_empcode,
                manager_name,
                process_name,
                manager_unique_code,
                manager_id
            )
        )
        if cursor.rowcount == 0:
            cursor.execute("SELECT ID FROM Managers WHERE ID = %s", (manager_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Manager not found")
        conn.commit()
        return {
            "id": manager_id,
            "manager_empcode": manager_empcode,
            "manager_name": manager_name,
            "process_name": process_name,
            "manager_unique_code": manager_unique_code
        }
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="Manager employee code or unique code already exists"
        )
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to update manager: {error}")
    finally:
        cursor.close()
        conn.close()

@app.delete("/api/managers/{manager_id}")
def delete_manager(manager_id: int, current_user: dict = Depends(get_current_user)):
    """SuperAdmin only: delete a Managers row."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM Managers WHERE ID = %s", (manager_id,))
        if cursor.rowcount == 0:
            conn.rollback()
            raise HTTPException(status_code=404, detail="Manager not found")
        conn.commit()
        return {"message": "Manager deleted"}
    except HTTPException:
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to delete manager: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/agent-process/options")
def get_agent_process_options(current_user: dict = Depends(get_current_user)):
    """SuperAdmin only: return available Process and LOB values."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(cursor)
        cursor.execute(
            """
            SELECT DISTINCT `Process`
            FROM AgentProcess
            WHERE COALESCE(TRIM(`Process`), '') <> ''
            ORDER BY `Process`
            """
        )
        processes = [row["Process"] for row in cursor.fetchall()]
        cursor.execute(
            """
            SELECT DISTINCT LOBName
            FROM AgentProcess
            WHERE COALESCE(TRIM(LOBName), '') <> ''
            ORDER BY LOBName
            """
        )
        lobs = [row["LOBName"] for row in cursor.fetchall()]
        cursor.execute(
            """
            SELECT DISTINCT `Process`, LOBName
            FROM AgentProcess
            WHERE COALESCE(TRIM(`Process`), '') <> ''
              AND COALESCE(TRIM(LOBName), '') <> ''
            ORDER BY `Process`, LOBName
            """
        )
        lobs_by_process = {}
        for row in cursor.fetchall():
            lobs_by_process.setdefault(row["Process"], []).append(row["LOBName"])

        return {
            "processes": processes,
            "lobs": lobs,
            "lobs_by_process": lobs_by_process
        }
    finally:
        cursor.close()
        conn.close()

@app.get(
    "/api/managers/{manager_id}/assignment-employees",
    response_model=list[ManagerEmployeeOut]
)
def get_manager_assignment_employees(
    manager_id: int,
    assigned_only: bool = Query(False),
    search_id: Optional[str] = Query(None),
    search_name: Optional[str] = Query(None),
    emp_codes: Optional[str] = Query(None),
    process_name: Optional[str] = Query(None),
    lob_name: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: list assigned employees or search assignment candidates."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(cursor)
        cursor.execute(
            "SELECT ID, managar_unique_code FROM Managers WHERE ID = %s",
            (manager_id,)
        )
        manager = cursor.fetchone()
        if not manager:
            raise HTTPException(status_code=404, detail="Manager not found")

        select_sql = """
            SELECT
                e.ID AS id,
                e.EmpName AS emp_name,
                COALESCE(e.Designation, 'Not specified') AS designation,
                COALESCE(e.Role, 'Employee') AS role,
                e.EmpCode AS emp_code,
                e.assign_manager_id AS assigned_manager_unique_code,
                m.Manager_Name AS assigned_manager_name,
                (
                    SELECT ap.`Process`
                    FROM AgentProcess ap
                    WHERE UPPER(ap.EmpCode) = UPPER(e.EmpCode)
                    ORDER BY ap.ID DESC
                    LIMIT 1
                ) AS process_name,
                (
                    SELECT ap.LOBName
                    FROM AgentProcess ap
                    WHERE UPPER(ap.EmpCode) = UPPER(e.EmpCode)
                    ORDER BY ap.ID DESC
                    LIMIT 1
                ) AS lob_name
            FROM EmployeeDetails e
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
        """
        params = []
        if assigned_only:
            select_sql += " AND e.assign_manager_id = %s"
            params.append(manager["managar_unique_code"])
        else:
            cleaned_id = (search_id or "").strip()
            cleaned_name = (search_name or "").strip()
            cleaned_process = (process_name or "").strip()
            cleaned_lob = (lob_name or "").strip()
            cleaned_codes = list(dict.fromkeys(
                code.strip().upper()
                for code in (emp_codes or "").split(",")
                if code.strip()
            ))
            if len(cleaned_codes) > 100:
                raise HTTPException(
                    status_code=400,
                    detail="You can search a maximum of 100 employee codes at once"
                )
            select_sql += " AND (e.assign_manager_id IS NULL OR e.assign_manager_id <> %s)"
            params.append(manager["managar_unique_code"])
            if cleaned_codes:
                code_placeholders = ",".join(["%s"] * len(cleaned_codes))
                select_sql += f" AND UPPER(e.EmpCode) IN ({code_placeholders})"
                params.extend(cleaned_codes)
            if cleaned_id:
                select_sql += " AND (CAST(e.ID AS CHAR) LIKE %s OR UPPER(e.EmpCode) LIKE UPPER(%s))"
                search_pattern = f"%{cleaned_id}%"
                params.extend([search_pattern, search_pattern])
            if cleaned_name:
                select_sql += " AND e.EmpName LIKE %s"
                params.append(f"%{cleaned_name}%")
            if cleaned_process and cleaned_lob:
                select_sql += """
                    AND EXISTS (
                        SELECT 1
                        FROM AgentProcess ap
                        WHERE UPPER(ap.EmpCode) = UPPER(e.EmpCode)
                          AND UPPER(ap.`Process`) = UPPER(%s)
                          AND UPPER(ap.LOBName) = UPPER(%s)
                    )
                """
                params.extend([cleaned_process, cleaned_lob])
            elif cleaned_process:
                select_sql += """
                    AND EXISTS (
                        SELECT 1
                        FROM AgentProcess ap
                        WHERE UPPER(ap.EmpCode) = UPPER(e.EmpCode)
                          AND UPPER(ap.`Process`) = UPPER(%s)
                    )
                """
                params.append(cleaned_process)
            elif cleaned_lob:
                select_sql += """
                    AND EXISTS (
                        SELECT 1
                        FROM AgentProcess ap
                        WHERE UPPER(ap.EmpCode) = UPPER(e.EmpCode)
                          AND UPPER(ap.LOBName) = UPPER(%s)
                    )
                """
                params.append(cleaned_lob)

        if assigned_only:
            cleaned_id = (search_id or "").strip()
            cleaned_name = (search_name or "").strip()
            if cleaned_id:
                select_sql += " AND (CAST(e.ID AS CHAR) LIKE %s OR UPPER(e.EmpCode) LIKE UPPER(%s))"
                search_pattern = f"%{cleaned_id}%"
                params.extend([search_pattern, search_pattern])
            if cleaned_name:
                select_sql += " AND e.EmpName LIKE %s"
                params.append(f"%{cleaned_name}%")

        select_sql += " ORDER BY e.EmpName, e.ID"
        select_sql += " LIMIT %s OFFSET %s"
        params.extend([limit, offset])
        cursor.execute(select_sql, tuple(params))
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()

@app.post("/api/managers/{manager_id}/assign-employees")
def assign_employees_to_manager(
    manager_id: int,
    assignment: EmployeeAssignmentRequest,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: assign or move selected employees to a manager."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    employee_ids = list(dict.fromkeys(assignment.employee_ids))
    if not employee_ids:
        raise HTTPException(status_code=400, detail="Select at least one employee")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT managar_unique_code FROM Managers WHERE ID = %s",
            (manager_id,)
        )
        manager = cursor.fetchone()
        if not manager:
            raise HTTPException(status_code=404, detail="Manager not found")

        placeholders = ",".join(["%s"] * len(employee_ids))
        cursor.execute(
            f"""
            UPDATE EmployeeDetails
            SET assign_manager_id = %s
            WHERE ID IN ({placeholders})
              AND LOWER(COALESCE(Role, 'Employee')) = 'employee'
            """,
            tuple([manager["managar_unique_code"], *employee_ids])
        )
        updated_count = cursor.rowcount
        conn.commit()
        return {
            "message": f"{updated_count} employee(s) assigned",
            "updated_count": updated_count
        }
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to assign employees: {error}")
    finally:
        cursor.close()
        conn.close()

@app.post("/api/managers/{manager_id}/remove-employees")
def remove_employees_from_manager(
    manager_id: int,
    assignment: EmployeeAssignmentRequest,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: remove selected employees from this manager."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    employee_ids = list(dict.fromkeys(assignment.employee_ids))
    if not employee_ids:
        raise HTTPException(status_code=400, detail="Select at least one employee")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT managar_unique_code FROM Managers WHERE ID = %s",
            (manager_id,)
        )
        manager = cursor.fetchone()
        if not manager:
            raise HTTPException(status_code=404, detail="Manager not found")

        placeholders = ",".join(["%s"] * len(employee_ids))
        cursor.execute(
            f"""
            UPDATE EmployeeDetails
            SET assign_manager_id = NULL
            WHERE ID IN ({placeholders})
              AND assign_manager_id = %s
            """,
            tuple([*employee_ids, manager["managar_unique_code"]])
        )
        updated_count = cursor.rowcount
        conn.commit()
        return {
            "message": f"{updated_count} employee assignment(s) removed",
            "updated_count": updated_count
        }
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(
            status_code=400,
            detail=f"Unable to remove employee assignments: {error}"
        )
    finally:
        cursor.close()
        conn.close()

@app.post("/api/employees", response_model=EmployeeOut, status_code=201)
def create_employee(
    employee: EmployeeCreate,
    current_user: dict = Depends(get_current_user)
):
    """Add an employee. ID is generated by MySQL."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    normalized_employee = normalize_employee(employee)

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        created_employee = insert_employee_rows(
            cursor,
            normalized_employee,
            current_user["emp_code"]
        )
        conn.commit()
        return created_employee
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Employee code already exists")
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to add employee: {error}")
    finally:
        cursor.close()
        conn.close()

@app.post("/api/employees/bulk", response_model=EmployeeBulkOut, status_code=201)
def create_employees_bulk(
    request: EmployeeBulkCreate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: add multiple employees to both employee tables."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")
    if not request.employees:
        raise HTTPException(status_code=400, detail="Add at least one employee")
    if len(request.employees) > 500:
        raise HTTPException(status_code=400, detail="You can add a maximum of 500 employees at once")

    normalized_employees = [normalize_employee(employee) for employee in request.employees]
    emp_codes = [employee["emp_code"] for employee in normalized_employees]
    seen_codes = set()
    duplicate_codes = set()
    for code in emp_codes:
        if code in seen_codes:
            duplicate_codes.add(code)
        seen_codes.add(code)
    duplicate_codes = sorted(duplicate_codes)
    if duplicate_codes:
        raise HTTPException(
            status_code=400,
            detail=f"Duplicate employee codes in bulk data: {', '.join(duplicate_codes)}"
        )

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        placeholders = ",".join(["%s"] * len(emp_codes))
        cursor.execute(
            f"""
            SELECT EmpCode
            FROM EmployeeDetails
            WHERE UPPER(EmpCode) IN ({placeholders})
            """,
            tuple(emp_codes)
        )
        existing_codes = sorted(row["EmpCode"] for row in cursor.fetchall())
        if existing_codes:
            raise HTTPException(
                status_code=409,
                detail=f"Employee code already exists: {', '.join(existing_codes)}"
            )

        created_employees = [
            insert_employee_rows(cursor, employee, current_user["emp_code"])
            for employee in normalized_employees
        ]
        conn.commit()
        return {
            "created_count": len(created_employees),
            "employees": created_employees
        }
    except HTTPException:
        conn.rollback()
        raise
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="One or more employee codes already exist")
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to add employees: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/employees", response_model=list[EmployeeOut])
def get_employees(
    search_id: Optional[str] = Query(None),
    search_name: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(get_current_user)
):
    """Search employees and include their latest AgentProcess details."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    cleaned_id = (search_id or "").strip()
    cleaned_name = (search_name or "").strip()
    if not cleaned_id and not cleaned_name:
        return []

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(cursor)
        select_sql = """
            SELECT
                e.ID,
                e.EmpName,
                e.Designation,
                e.Role,
                e.EmpCode,
                ap.`Process` AS ProcessName,
                ap.LOBName,
                COALESCE(aa.Status, 'Active') AS ApplicationStatus
            FROM EmployeeDetails e
            LEFT JOIN (
                SELECT current_ap.*
                FROM AgentProcess current_ap
                INNER JOIN (
                    SELECT EmpCode, MAX(ID) AS LatestID
                    FROM AgentProcess
                    GROUP BY EmpCode
                ) latest_ap
                    ON current_ap.ID = latest_ap.LatestID
            ) ap
                ON ap.EmpCode = e.EmpCode
            LEFT JOIN ApplicationAccess aa
                ON BINARY aa.EmpCode = BINARY e.EmpCode
            WHERE 1 = 1
        """
        params = []
        if cleaned_id:
            select_sql += " AND (CAST(e.ID AS CHAR) LIKE %s OR e.EmpCode LIKE %s)"
            id_pattern = f"%{cleaned_id}%"
            params.extend([id_pattern, id_pattern])
        if cleaned_name:
            select_sql += " AND e.EmpName LIKE %s"
            params.append(f"%{cleaned_name}%")
        select_sql += " ORDER BY e.EmpName, e.ID LIMIT %s"
        params.append(limit)
        cursor.execute(select_sql, tuple(params))
        rows = cursor.fetchall()
        return [
            {
                "id": row["ID"],
                "emp_name": row["EmpName"],
                "designation": row["Designation"],
                "role": row["Role"],
                "emp_code": row["EmpCode"],
                "process_name": row["ProcessName"],
                "lob_name": row["LOBName"],
                "status": row["ApplicationStatus"]
            }
            for row in rows
        ]
    finally:
        cursor.close()
        conn.close()

@app.put("/api/employees/{employee_id}", response_model=EmployeeOut)
def update_employee(
    employee_id: int,
    employee: EmployeeUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an EmployeeDetails row."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    normalized_employee = normalize_employee(employee)

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "SELECT EmpCode FROM EmployeeDetails WHERE ID = %s",
            (employee_id,)
        )
        existing_employee = cursor.fetchone()
        if not existing_employee:
            raise HTTPException(status_code=404, detail="Employee not found")

        cursor.execute(
            """
            UPDATE EmployeeDetails
            SET EmpName = %s, Designation = %s, Role = %s, EmpCode = %s
            WHERE ID = %s
            """,
            (
                normalized_employee["emp_name"],
                normalized_employee["designation"],
                normalized_employee["role"],
                normalized_employee["emp_code"],
                employee_id
            )
        )
        upsert_agent_process(
            cursor,
            normalized_employee,
            existing_employee["EmpCode"]
        )
        if existing_employee["EmpCode"].upper() != normalized_employee["emp_code"]:
            cursor.execute(
                """
                DELETE FROM ApplicationAccess
                WHERE UPPER(EmpCode) = UPPER(%s)
                """,
                (existing_employee["EmpCode"],)
            )
        upsert_application_access(
            cursor,
            normalized_employee["emp_code"],
            normalized_employee["status"],
            current_user["emp_code"]
        )
        conn.commit()
        return {"id": employee_id, **normalized_employee}
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Employee code already exists")
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to update employee: {error}")
    finally:
        cursor.close()
        conn.close()

@app.delete("/api/employees/{employee_id}")
def delete_employee(employee_id: int, current_user: dict = Depends(get_current_user)):
    """SuperAdmin only: remove an EmployeeDetails row."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM EmployeeDetails WHERE ID = %s", (employee_id,))
        if cursor.rowcount == 0:
            conn.rollback()
            raise HTTPException(status_code=404, detail="Employee not found")
        conn.commit()
        return {"message": "Employee removed"}
    except HTTPException:
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to remove employee: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/roster/shifts", response_model=list[ShiftOut])
def get_roster_shifts(current_user: dict = Depends(get_current_user)):
    """Return shifts to SuperAdmin and managers."""
    role = str(current_user.get("role", "")).lower()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(status_code=403, detail="Roster access required")
        ensure_roster_tables(cursor)
        cursor.execute(
            """
            SELECT ID, ShiftName, StartTime, EndTime, GraceMinutes,
                   BreakMinutes, Status
            FROM Shifts
            ORDER BY FIELD(Status, 'Active', 'Inactive'), ShiftName
            """
        )
        return [shift_to_dict(row) for row in cursor.fetchall()]
    finally:
        cursor.close()
        conn.close()

@app.post("/api/roster/shifts", response_model=ShiftOut, status_code=201)
def create_roster_shift(
    shift: ShiftCreate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: create a reusable shift definition."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    shift_name = shift.shift_name.strip()
    start_time = parse_time_value(shift.start_time, "Start time")
    end_time = parse_time_value(shift.end_time, "End time")
    duration = shift_duration_minutes(start_time, end_time)
    if not shift_name:
        raise HTTPException(status_code=400, detail="Shift name is required")
    if not 0 <= shift.grace_minutes <= 180:
        raise HTTPException(status_code=400, detail="Grace minutes must be between 0 and 180")
    if not 0 <= shift.break_minutes < duration:
        raise HTTPException(
            status_code=400,
            detail="Break minutes must be less than the shift duration"
        )

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_roster_tables(cursor)
        cursor.execute(
            """
            INSERT INTO Shifts (
                ShiftName, StartTime, EndTime, GraceMinutes,
                BreakMinutes, Status, CreatedBy
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                shift_name,
                start_time.strftime("%H:%M:%S"),
                end_time.strftime("%H:%M:%S"),
                shift.grace_minutes,
                shift.break_minutes,
                shift.status,
                current_user["emp_code"]
            )
        )
        shift_id = cursor.lastrowid
        conn.commit()
        cursor.execute(
            """
            SELECT ID, ShiftName, StartTime, EndTime, GraceMinutes,
                   BreakMinutes, Status
            FROM Shifts
            WHERE ID = %s
            """,
            (shift_id,)
        )
        return shift_to_dict(cursor.fetchone())
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Shift name already exists")
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.put("/api/roster/shifts/{shift_id}", response_model=ShiftOut)
def update_roster_shift(
    shift_id: int,
    shift: ShiftCreate,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: update a shift definition."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    shift_name = shift.shift_name.strip()
    start_time = parse_time_value(shift.start_time, "Start time")
    end_time = parse_time_value(shift.end_time, "End time")
    duration = shift_duration_minutes(start_time, end_time)
    if not shift_name:
        raise HTTPException(status_code=400, detail="Shift name is required")
    if not 0 <= shift.grace_minutes <= 180:
        raise HTTPException(status_code=400, detail="Grace minutes must be between 0 and 180")
    if not 0 <= shift.break_minutes < duration:
        raise HTTPException(
            status_code=400,
            detail="Break minutes must be less than the shift duration"
        )

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_roster_tables(cursor)
        cursor.execute(
            """
            UPDATE Shifts
            SET ShiftName = %s, StartTime = %s, EndTime = %s,
                GraceMinutes = %s, BreakMinutes = %s, Status = %s
            WHERE ID = %s
            """,
            (
                shift_name,
                start_time.strftime("%H:%M:%S"),
                end_time.strftime("%H:%M:%S"),
                shift.grace_minutes,
                shift.break_minutes,
                shift.status,
                shift_id
            )
        )
        if cursor.rowcount == 0:
            conn.rollback()
            raise HTTPException(status_code=404, detail="Shift not found")
        conn.commit()
        cursor.execute(
            """
            SELECT ID, ShiftName, StartTime, EndTime, GraceMinutes,
                   BreakMinutes, Status
            FROM Shifts
            WHERE ID = %s
            """,
            (shift_id,)
        )
        return shift_to_dict(cursor.fetchone())
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Shift name already exists")
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.delete("/api/roster/shifts/{shift_id}")
def delete_roster_shift(
    shift_id: int,
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: delete an unused shift."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_roster_tables(cursor)
        cursor.execute(
            "SELECT COUNT(*) AS RosterCount FROM EmployeeRoster WHERE ShiftID = %s",
            (shift_id,)
        )
        if cursor.fetchone()["RosterCount"] > 0:
            raise HTTPException(
                status_code=409,
                detail="This shift is used in roster entries. Mark it Inactive instead."
            )
        cursor.execute("DELETE FROM Shifts WHERE ID = %s", (shift_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Shift not found")
        conn.commit()
        return {"message": "Shift deleted"}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.get("/api/roster/employees", response_model=list[RosterEmployeeOut])
def get_roster_employees(
    search: Optional[str] = Query(None),
    process_name: Optional[str] = Query(None),
    lob_name: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    current_user: dict = Depends(get_current_user)
):
    """Search employees available to the signed-in roster owner."""
    role = str(current_user.get("role", "")).lower()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(cursor)
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(status_code=403, detail="Roster access required")
        employee_sql = """
            SELECT DISTINCT
                e.EmpCode AS emp_code,
                e.EmpName AS name,
                COALESCE(ap.`Process`, 'Unassigned') AS process_name,
                COALESCE(ap.LOBName, 'Unassigned') AS lob_name,
                m.Manager_Name AS manager_name
            FROM EmployeeDetails e
            LEFT JOIN AgentProcess ap ON ap.EmpCode = e.EmpCode
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
              AND LOWER(COALESCE(ap.Status, 'Active')) = 'active'
        """
        params = []
        if role != "superadmin":
            employee_sql += " AND e.assign_manager_id = %s"
            params.append(manager["managar_unique_code"])
        cleaned_search = (search or "").strip()
        cleaned_process = (process_name or "").strip()
        cleaned_lob = (lob_name or "").strip()
        if cleaned_search:
            employee_sql += " AND (e.EmpCode LIKE %s OR e.EmpName LIKE %s)"
            pattern = f"%{cleaned_search}%"
            params.extend([pattern, pattern])
        if cleaned_process:
            employee_sql += " AND ap.`Process` = %s"
            params.append(cleaned_process)
        if cleaned_lob:
            employee_sql += " AND ap.LOBName = %s"
            params.append(cleaned_lob)
        employee_sql += " ORDER BY name LIMIT %s"
        params.append(limit)
        cursor.execute(employee_sql, tuple(params))
        return cursor.fetchall()
    finally:
        cursor.close()
        conn.close()

@app.get("/api/roster", response_model=list[RosterEntryOut])
def get_employee_roster(
    date_from: str = Query(...),
    date_to: str = Query(...),
    search: Optional[str] = Query(None),
    process_name: Optional[str] = Query(None),
    lob_name: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=2000),
    current_user: dict = Depends(get_current_user)
):
    """List roster entries within the signed-in user's access scope."""
    try:
        start_date = date.fromisoformat(date_from)
        end_date = date.fromisoformat(date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format")
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="From date cannot be after To date")
    if (end_date - start_date).days > 92:
        raise HTTPException(status_code=400, detail="Select a date range of 93 days or less")

    role = str(current_user.get("role", "")).lower()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_roster_tables(cursor)
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(status_code=403, detail="Roster access required")
        roster_sql = """
            SELECT
                r.ID AS id,
                r.EmpCode AS emp_code,
                e.EmpName AS name,
                r.RosterDate AS roster_date,
                r.DayType AS day_type,
                s.ID AS shift_id,
                s.ShiftName AS shift_name,
                s.StartTime AS start_time,
                s.EndTime AS end_time,
                s.GraceMinutes AS grace_minutes,
                s.BreakMinutes AS break_minutes,
                COALESCE(r.ProcessName, 'Unassigned') AS process_name,
                COALESCE(r.LOBName, 'Unassigned') AS lob_name,
                m.Manager_Name AS manager_name,
                r.CreatedBy AS created_by
            FROM EmployeeRoster r
            INNER JOIN EmployeeDetails e
                ON BINARY e.EmpCode = BINARY r.EmpCode
            LEFT JOIN Shifts s ON s.ID = r.ShiftID
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE r.RosterDate >= %s AND r.RosterDate <= %s
        """
        params = [start_date, end_date]
        if role != "superadmin":
            roster_sql += " AND e.assign_manager_id = %s"
            params.append(manager["managar_unique_code"])
        cleaned_search = (search or "").strip()
        if cleaned_search:
            roster_sql += " AND (r.EmpCode LIKE %s OR e.EmpName LIKE %s)"
            pattern = f"%{cleaned_search}%"
            params.extend([pattern, pattern])
        if (process_name or "").strip():
            roster_sql += " AND r.ProcessName = %s"
            params.append(process_name.strip())
        if (lob_name or "").strip():
            roster_sql += " AND r.LOBName = %s"
            params.append(lob_name.strip())
        roster_sql += " ORDER BY r.RosterDate DESC, e.EmpName LIMIT %s"
        params.append(limit)
        cursor.execute(roster_sql, tuple(params))
        rows = cursor.fetchall()
        return [
            {
                **row,
                "roster_date": str(row["roster_date"]),
                "start_time": database_time_text(row["start_time"]) if row["start_time"] else None,
                "end_time": database_time_text(row["end_time"]) if row["end_time"] else None
            }
            for row in rows
        ]
    finally:
        cursor.close()
        conn.close()

@app.post("/api/roster/assign", response_model=RosterAssignmentOut)
def assign_employee_roster(
    assignment: RosterAssignmentCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create or replace roster entries for one or more accessible employees."""
    try:
        start_date = date.fromisoformat(assignment.date_from)
        end_date = date.fromisoformat(assignment.date_to)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format")
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="From date cannot be after To date")
    if (end_date - start_date).days > 366:
        raise HTTPException(status_code=400, detail="Roster range cannot exceed 367 days")
    weekdays = sorted(set(assignment.weekdays))
    if not weekdays or any(day < 0 or day > 6 for day in weekdays):
        raise HTTPException(status_code=400, detail="Select at least one valid weekday")
    emp_codes = list(dict.fromkeys(
        code.strip().upper() for code in assignment.emp_codes if code.strip()
    ))
    if not emp_codes:
        raise HTTPException(status_code=400, detail="Enter at least one employee code")
    if len(emp_codes) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 employees per assignment")
    if assignment.day_type == "Working" and not assignment.shift_id:
        raise HTTPException(status_code=400, detail="Select a shift for Working days")

    role = str(current_user.get("role", "")).lower()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(cursor)
        ensure_roster_tables(cursor)
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(status_code=403, detail="Roster access required")

        if assignment.shift_id:
            cursor.execute(
                "SELECT ID, Status FROM Shifts WHERE ID = %s",
                (assignment.shift_id,)
            )
            shift = cursor.fetchone()
            if not shift:
                raise HTTPException(status_code=404, detail="Shift not found")
            if assignment.day_type == "Working" and shift["Status"] != "Active":
                raise HTTPException(status_code=400, detail="Select an active shift")

        placeholders = ",".join(["%s"] * len(emp_codes))
        employee_sql = f"""
            SELECT DISTINCT
                e.EmpCode,
                COALESCE(ap.`Process`, 'Unassigned') AS ProcessName,
                COALESCE(ap.LOBName, 'Unassigned') AS LOBName
            FROM EmployeeDetails e
            LEFT JOIN AgentProcess ap ON ap.EmpCode = e.EmpCode
            WHERE UPPER(e.EmpCode) IN ({placeholders})
              AND LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
        """
        employee_params = list(emp_codes)
        if role != "superadmin":
            employee_sql += " AND e.assign_manager_id = %s"
            employee_params.append(manager["managar_unique_code"])
        cursor.execute(employee_sql, tuple(employee_params))
        employees = cursor.fetchall()
        employee_map = {row["EmpCode"].upper(): row for row in employees}
        inaccessible_codes = [code for code in emp_codes if code not in employee_map]
        if inaccessible_codes:
            raise HTTPException(
                status_code=403,
                detail=f"Employee not found or outside your access: {', '.join(inaccessible_codes[:10])}"
            )

        roster_dates = []
        current_date = start_date
        while current_date <= end_date:
            if current_date.weekday() in weekdays:
                roster_dates.append(current_date)
            current_date += timedelta(days=1)
        if not roster_dates:
            raise HTTPException(status_code=400, detail="No dates match the selected weekdays")

        created_count = 0
        updated_count = 0
        roster_shift_id = assignment.shift_id if assignment.day_type == "Working" else None
        for emp_code in emp_codes:
            employee = employee_map[emp_code]
            for roster_date in roster_dates:
                cursor.execute(
                    """
                    INSERT INTO EmployeeRoster (
                        EmpCode, RosterDate, ShiftID, DayType,
                        ProcessName, LOBName, CreatedBy
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        ShiftID = VALUES(ShiftID),
                        DayType = VALUES(DayType),
                        ProcessName = VALUES(ProcessName),
                        LOBName = VALUES(LOBName),
                        CreatedBy = VALUES(CreatedBy)
                    """,
                    (
                        emp_code,
                        roster_date,
                        roster_shift_id,
                        assignment.day_type,
                        employee["ProcessName"],
                        employee["LOBName"],
                        current_user["emp_code"]
                    )
                )
                if cursor.rowcount == 1:
                    created_count += 1
                else:
                    updated_count += 1
        conn.commit()
        return {
            "created_count": created_count,
            "updated_count": updated_count,
            "roster_dates": len(roster_dates),
            "employee_count": len(emp_codes)
        }
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.delete("/api/roster/{roster_id}")
def delete_roster_entry(
    roster_id: int,
    current_user: dict = Depends(get_current_user)
):
    """Delete one roster entry within the signed-in user's scope."""
    role = str(current_user.get("role", "")).lower()
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        ensure_roster_tables(cursor)
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(status_code=403, detail="Roster access required")
        delete_sql = """
            DELETE r
            FROM EmployeeRoster r
            INNER JOIN EmployeeDetails e
                ON BINARY e.EmpCode = BINARY r.EmpCode
            WHERE r.ID = %s
        """
        params = [roster_id]
        if role != "superadmin":
            delete_sql += " AND e.assign_manager_id = %s"
            params.append(manager["managar_unique_code"])
        cursor.execute(delete_sql, tuple(params))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Roster entry not found")
        conn.commit()
        return {"message": "Roster entry deleted"}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

@app.get("/api/reports/adherence", response_model=ReportOut)
def get_adherence_report(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    process_name: Optional[str] = Query(None),
    lob_name: Optional[str] = Query(None),
    agent_search: Optional[str] = Query(None),
    detail: Literal["summary", "agent", "date"] = Query("summary"),
    current_user: dict = Depends(get_current_user)
):
    """Return process and LOB adherence, scoped to SuperAdmin or assigned manager access."""
    today = datetime.now().date()
    default_start = today.replace(day=1)
    try:
        start_date = date.fromisoformat(date_from) if date_from else default_start
        end_date = date.fromisoformat(date_to) if date_to else today
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must use YYYY-MM-DD format")

    if start_date > end_date:
        raise HTTPException(status_code=400, detail="From date cannot be after To date")
    if end_date > today:
        raise HTTPException(status_code=400, detail="Report dates cannot be in the future")
    if (end_date - start_date).days > 92:
        raise HTTPException(status_code=400, detail="Select a date range of 93 days or less")

    role = str(current_user.get("role", "")).lower()
    mysql_conn = get_mysql_connection()
    mysql_cursor = mysql_conn.cursor(dictionary=True)
    try:
        ensure_agent_process_table(mysql_cursor)
        ensure_roster_tables(mysql_cursor)
        manager = get_manager_for_user(mysql_cursor, current_user["emp_code"])
        if role != "superadmin" and not manager:
            raise HTTPException(
                status_code=403,
                detail="Report access is limited to SuperAdmin and assigned managers"
            )

        employee_sql = """
            SELECT DISTINCT
                e.EmpCode AS emp_code,
                e.EmpName AS name,
                COALESCE(ap.`Process`, 'Unassigned') AS process_name,
                COALESCE(ap.LOBName, 'Unassigned') AS lob_name,
                m.Manager_Name AS manager_name
            FROM EmployeeDetails e
            LEFT JOIN AgentProcess ap
                ON ap.EmpCode = e.EmpCode
            LEFT JOIN Managers m
                ON e.assign_manager_id = m.managar_unique_code
            WHERE LOWER(COALESCE(e.Role, 'Employee')) = 'employee'
              AND LOWER(COALESCE(ap.Status, 'Active')) = 'active'
        """
        employee_params = []
        if role != "superadmin":
            employee_sql += " AND e.assign_manager_id = %s"
            employee_params.append(manager["managar_unique_code"])
        employee_sql += " ORDER BY process_name, lob_name, name"
        mysql_cursor.execute(employee_sql, tuple(employee_params))
        scoped_employees = mysql_cursor.fetchall()

        process_options = sorted({
            row["process_name"] for row in scoped_employees
        }, key=str.lower)
        lob_options = sorted({
            row["lob_name"] for row in scoped_employees
        }, key=str.lower)

        selected_process = (process_name or "").strip().lower()
        selected_lob = (lob_name or "").strip().lower()
        selected_agent = (agent_search or "").strip().lower()
        employees = [
            row for row in scoped_employees
            if (
                (not selected_process or row["process_name"].lower() == selected_process)
                and (not selected_lob or row["lob_name"].lower() == selected_lob)
                and (
                    not selected_agent
                    or selected_agent in row["emp_code"].lower()
                    or selected_agent in row["name"].lower()
                )
            )
        ]

        mysql_cursor.execute(
            """
            SELECT HolidayDate
            FROM Holidays
            WHERE HolidayDate >= %s AND HolidayDate <= %s
            """,
            (start_date.isoformat(), end_date.isoformat())
        )
        holiday_dates = {
            (
                row["HolidayDate"].isoformat()
                if hasattr(row["HolidayDate"], "isoformat")
                else str(row["HolidayDate"])
            )
            for row in mysql_cursor.fetchall()
        }
        mysql_cursor.execute(
            """
            SELECT
                r.EmpCode,
                r.RosterDate,
                r.DayType,
                s.ShiftName,
                s.StartTime,
                s.EndTime,
                s.GraceMinutes,
                s.BreakMinutes
            FROM EmployeeRoster r
            LEFT JOIN Shifts s ON s.ID = r.ShiftID
            WHERE r.RosterDate >= %s AND r.RosterDate <= %s
            """,
            (start_date, end_date)
        )
        selected_employee_codes = {
            row["emp_code"].upper() for row in employees
        }
        roster_map = {}
        for row in mysql_cursor.fetchall():
            emp_code = row["EmpCode"].upper()
            if emp_code not in selected_employee_codes:
                continue
            roster_date = (
                row["RosterDate"].isoformat()
                if hasattr(row["RosterDate"], "isoformat")
                else str(row["RosterDate"])
            )
            roster_map[(emp_code, roster_date)] = row
    finally:
        mysql_cursor.close()
        mysql_conn.close()

    all_dates = []
    default_working_dates = []
    current_date = start_date
    while current_date <= end_date:
        date_key = current_date.isoformat()
        all_dates.append(current_date)
        if current_date.weekday() != 6 and date_key not in holiday_dates:
            default_working_dates.append(current_date)
        current_date += timedelta(days=1)

    employee_by_code = {
        row["emp_code"].upper(): row
        for row in employees
    }
    employee_codes = list(employee_by_code)
    employee_code_set = set(employee_codes)
    report_date_keys = {report_date.isoformat() for report_date in all_dates}
    parameter_marker = "%s" if SQL_CONNECTION_MODE == "pymssql" else "?"
    attendance_query_base = f"""
        SELECT
            UserID,
            CAST(Edatetime AS DATE) AS AttendanceDate,
            MIN(Edatetime) AS FirstPunchIn,
            MAX(Edatetime) AS LastPunchOut,
            DATEDIFF(MINUTE, MIN(Edatetime), MAX(Edatetime)) AS WorkingMinutes
        FROM Mx_ATDEventTrn
        WHERE Edatetime >= {parameter_marker}
          AND Edatetime < {parameter_marker}
    """
    attendance_date_params = [
        datetime.combine(start_date, time.min),
        datetime.combine(end_date + timedelta(days=1), time.min)
    ]

    try:
        attendance_rows = []
        if employee_codes:
            with get_attendance_connection() as attendance_conn:
                attendance_cursor = attendance_conn.cursor()
                for offset in range(0, len(employee_codes), 2000):
                    code_chunk = employee_codes[offset:offset + 2000]
                    placeholders = ",".join([parameter_marker] * len(code_chunk))
                    attendance_query = (
                        attendance_query_base
                        + f" AND UserID IN ({placeholders})"
                        + " GROUP BY UserID, CAST(Edatetime AS DATE)"
                    )
                    attendance_cursor.execute(
                        attendance_query,
                        tuple([*attendance_date_params, *code_chunk])
                    )
                    attendance_rows.extend(attendance_cursor.fetchall())
    except pymssql.Error as error:
        raise HTTPException(status_code=500, detail=f"Attendance DB error: {error}")
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Unable to build report: {error}")

    try:
        default_shift_start = datetime.strptime(
            os.getenv("REPORT_SHIFT_START", "10:00"),
            "%H:%M"
        ).time()
    except ValueError:
        default_shift_start = time(10, 0)
    try:
        default_grace_minutes = max(
            0,
            int(os.getenv("REPORT_LATE_GRACE_MINUTES", "15"))
        )
    except ValueError:
        default_grace_minutes = 15
    try:
        default_productive_minutes = max(
            1,
            int(os.getenv("REPORT_PRODUCTIVE_MINUTES", "540"))
        )
    except ValueError:
        default_productive_minutes = 540

    default_working_keys = {
        report_date.isoformat() for report_date in default_working_dates
    }
    overall_metric = empty_report_metric(0, 0, 0)
    process_metrics = {}
    lob_metrics = {}
    agent_metrics = {}
    daily_metrics = {}
    schedule_map = {}
    overall_daily_mandate = {}
    process_daily_mandate = {}
    lob_daily_mandate = {}
    process_working_dates = {}
    lob_working_dates = {}
    agent_working_dates = {}

    for employee in employees:
        process_key = employee["process_name"]
        lob_key = (process_key, employee["lob_name"])
        process_metrics.setdefault(process_key, empty_report_metric(0, 0, 0))
        lob_metrics.setdefault(lob_key, empty_report_metric(0, 0, 0))
        agent_metrics[employee["emp_code"]] = empty_report_metric(0, 0, 0)
        process_working_dates.setdefault(process_key, set())
        lob_working_dates.setdefault(lob_key, set())
        agent_working_dates[employee["emp_code"]] = set()

        for report_date in all_dates:
            date_key = report_date.isoformat()
            roster = roster_map.get((employee["emp_code"].upper(), date_key))
            is_planned = (
                roster["DayType"] == "Working"
                if roster
                else date_key in default_working_keys
            )
            if not is_planned:
                continue

            shift_name = "Default Shift"
            shift_start = default_shift_start
            grace_minutes = default_grace_minutes
            productive_minutes = default_productive_minutes
            if roster and roster.get("StartTime") is not None:
                shift_name = roster.get("ShiftName") or "Roster Shift"
                shift_start = database_time_value(roster["StartTime"])
                shift_end = database_time_value(roster["EndTime"])
                grace_minutes = int(roster.get("GraceMinutes") or 0)
                duration = shift_duration_minutes(shift_start, shift_end)
                productive_minutes = max(
                    duration - int(roster.get("BreakMinutes") or 0),
                    1
                )

            schedule_map[(employee["emp_code"].upper(), date_key)] = {
                "shift_name": shift_name,
                "start_time": shift_start,
                "grace_minutes": grace_minutes,
                "productive_minutes": productive_minutes
            }
            overall_metric["planned_agent_days"] += 1
            process_metrics[process_key]["planned_agent_days"] += 1
            lob_metrics[lob_key]["planned_agent_days"] += 1
            agent_metrics[employee["emp_code"]]["planned_agent_days"] += 1
            daily_metric = daily_metrics.setdefault(
                date_key,
                empty_report_metric(0, 1, 0)
            )
            daily_metric["planned_agent_days"] += 1
            overall_daily_mandate[date_key] = (
                overall_daily_mandate.get(date_key, 0) + 1
            )
            process_date_key = (process_key, date_key)
            process_daily_mandate[process_date_key] = (
                process_daily_mandate.get(process_date_key, 0) + 1
            )
            lob_date_key = (lob_key, date_key)
            lob_daily_mandate[lob_date_key] = (
                lob_daily_mandate.get(lob_date_key, 0) + 1
            )
            process_working_dates[process_key].add(date_key)
            lob_working_dates[lob_key].add(date_key)
            agent_working_dates[employee["emp_code"]].add(date_key)

    overall_metric["mandate"] = max(overall_daily_mandate.values(), default=0)
    overall_metric["working_days"] = len(overall_daily_mandate)
    for process_key, metric in process_metrics.items():
        metric["mandate"] = max(
            (
                count for (key, _), count in process_daily_mandate.items()
                if key == process_key
            ),
            default=0
        )
        metric["working_days"] = len(process_working_dates[process_key])
    for lob_key, metric in lob_metrics.items():
        metric["mandate"] = max(
            (
                count for (key, _), count in lob_daily_mandate.items()
                if key == lob_key
            ),
            default=0
        )
        metric["working_days"] = len(lob_working_dates[lob_key])
    for emp_code, metric in agent_metrics.items():
        metric["mandate"] = 1 if agent_working_dates[emp_code] else 0
        metric["working_days"] = len(agent_working_dates[emp_code])
    for date_key, metric in daily_metrics.items():
        metric["mandate"] = overall_daily_mandate.get(date_key, 0)

    for attendance in attendance_rows:
        emp_code = str(attendance[0]).upper()
        date_key = attendance[1].isoformat() if hasattr(attendance[1], "isoformat") else str(attendance[1])
        schedule = schedule_map.get((emp_code, date_key))
        if emp_code not in employee_code_set or not schedule:
            continue
        employee = employee_by_code[emp_code]
        working_minutes = int(attendance[4] or 0)
        productive_minutes = schedule["productive_minutes"]
        half_day_minutes = max((productive_minutes + 1) // 2, 1)
        if working_minutes >= productive_minutes:
            status = "Present"
        elif working_minutes >= half_day_minutes:
            status = "Half Day"
        else:
            status = "Absent"

        punctuality = "Not Counted"
        if status != "Absent":
            report_date = date.fromisoformat(date_key)
            first_punch = attendance[2]
            if not isinstance(first_punch, datetime):
                first_punch = datetime.fromisoformat(str(first_punch))
            late_cutoff = (
                datetime.combine(report_date, schedule["start_time"])
                + timedelta(minutes=schedule["grace_minutes"])
            )
            punctuality = "On Time" if first_punch <= late_cutoff else "Late"

        if status == "Absent":
            continue
        process_key = employee["process_name"]
        lob_key = (process_key, employee["lob_name"])
        for metric in (
            overall_metric,
            process_metrics[process_key],
            lob_metrics[lob_key],
            agent_metrics[employee["emp_code"]],
            daily_metrics[date_key]
        ):
            add_report_day(metric, status, punctuality)

    metrics_to_finalize = [
        overall_metric,
        *process_metrics.values(),
        *lob_metrics.values(),
        *agent_metrics.values(),
        *daily_metrics.values()
    ]
    for metric in metrics_to_finalize:
        metric["absent"] = max(
            metric["planned_agent_days"] - metric["present"] - metric["half_day"],
            0
        )

    daily_records = [
        {
            "attendance_date": date_key,
            "metrics": finalize_report_metric(daily_metrics[date_key])
        }
        for date_key in sorted(daily_metrics, reverse=True)
    ]

    processes = []
    for process_key in sorted(process_metrics, key=str.lower):
        lobs = [
            {
                "name": lob_key[1],
                "metrics": finalize_report_metric(lob_metrics[lob_key])
            }
            for lob_key in sorted(
                (key for key in lob_metrics if key[0] == process_key),
                key=lambda key: key[1].lower()
            )
        ]
        processes.append({
            "name": process_key,
            "metrics": finalize_report_metric(process_metrics[process_key]),
            "lobs": lobs
        })

    agents = []
    for employee in employees:
        agents.append({
            "emp_code": employee["emp_code"],
            "name": employee["name"],
            "process_name": employee["process_name"],
            "lob_name": employee["lob_name"],
            "manager_name": employee["manager_name"],
            "metrics": finalize_report_metric(agent_metrics[employee["emp_code"]])
        })

    agents.sort(
        key=lambda row: (
            -row["metrics"]["shrinkage_percent"],
            row["name"].lower()
        )
    )
    agent_count = len(agents)
    if detail != "agent":
        agents = agents[:500]
    scope_label = (
        "Overall organization"
        if role == "superadmin"
        else f"{manager['Manager_Name']} - assigned team"
    )
    return {
        "scope_label": scope_label,
        "date_from": start_date.isoformat(),
        "date_to": end_date.isoformat(),
        "shift_start": default_shift_start.strftime("%H:%M"),
        "late_grace_minutes": default_grace_minutes,
        "shift_rule_label": (
            "Assigned roster shift + shift grace"
            if roster_map
            else (
                f"Default {default_shift_start.strftime('%H:%M')} + "
                f"{default_grace_minutes} min grace"
            )
        ),
        "methodology": (
            "Mandate is the maximum number of agents scheduled on a day. Roster Working "
            "days use the assigned shift, grace and productive minutes. Weekly Off, Leave "
            "and Holiday are excluded. Unrostered dates use the default attendance rule."
        ),
        "overall": finalize_report_metric(overall_metric),
        "processes": processes,
        "agents": agents,
        "agent_count": agent_count,
        "daily_records": daily_records,
        "process_options": process_options,
        "lob_options": lob_options
    }

@app.get("/api/attendance", response_model=list[AttendanceRecord])
def get_attendance(
    current_user: dict = Depends(get_current_user),
    month: Optional[str] = Query(None),
    search_emp_code: Optional[str] = Query(None),
    search_emp_name: Optional[str] = Query(None)
):
    """
    Fetch attendance records from the SQL Server for the given month.
    Returns Name from MySQL database.
    SuperAdmin can search by emp_code or emp_name to view anyone's attendance.
    """
    if not month:
        month = datetime.now().strftime("%Y-%m")
    year, mon = map(int, month.split('-'))
    start_date = datetime(year, mon, 1)
    if mon == 12:
        end_date = datetime(year+1, 1, 1) - timedelta(days=1)
    else:
        end_date = datetime(year, mon+1, 1) - timedelta(days=1)

    is_superadmin = str(current_user.get("role", "")).lower() == "superadmin"
    target_emp_codes = []

    if is_superadmin and search_emp_code:
        target_emp_codes.append(search_emp_code.strip().upper())

    if is_superadmin and search_emp_name and not target_emp_codes:
        emp_conn = get_mysql_connection()
        emp_cursor = emp_conn.cursor(dictionary=True)
        emp_cursor.execute(
            "SELECT EmpCode FROM EmployeeDetails WHERE EmpName LIKE %s",
            (f"%{search_emp_name.strip()}%",)
        )
        rows = emp_cursor.fetchall()
        emp_cursor.close()
        emp_conn.close()
        for row in rows:
            target_emp_codes.append(row["EmpCode"])

    if not target_emp_codes:
        target_emp_codes.append(current_user["emp_code"].upper())

    # Get employee details from MySQL for all targets
    emp_map = {}
    try:
        emp_conn = get_mysql_connection()
        emp_cursor = emp_conn.cursor(dictionary=True)
        format_strings = ','.join(['%s'] * len(target_emp_codes))
        emp_cursor.execute(
            f"SELECT EmpCode, EmpName, Designation, Role FROM EmployeeDetails WHERE UPPER(EmpCode) IN ({format_strings})",
            tuple(target_emp_codes)
        )
        emp_rows = emp_cursor.fetchall()
        emp_cursor.close()
        emp_conn.close()
        for row in emp_rows:
            emp_map[row["EmpCode"].upper()] = row
    except Exception as e:
        print(f"Error fetching employee details: {e}")

    # Check Managers table for any missing codes
    missing_codes = [code for code in target_emp_codes if code.upper() not in emp_map]
    if missing_codes:
        try:
            emp_conn = get_mysql_connection()
            emp_cursor = emp_conn.cursor(dictionary=True)
            format_strings = ','.join(['%s'] * len(missing_codes))
            emp_cursor.execute(
                f"SELECT Manager_empcode, Manager_Name, Process_name FROM Managers WHERE UPPER(Manager_empcode) IN ({format_strings})",
                tuple(missing_codes)
            )
            mgr_rows = emp_cursor.fetchall()
            emp_cursor.close()
            emp_conn.close()
            for row in mgr_rows:
                code = row["Manager_empcode"].upper()
                emp_map[code] = {
                    "EmpCode": code,
                    "EmpName": row.get("Manager_Name") or "Manager",
                    "Designation": row.get("Process_name") or "Manager",
                    "Role": "Manager"
                }
        except Exception as e:
            print(f"Error fetching manager details: {e}")

    for code in target_emp_codes:
        ucode = code.upper()
        if ucode not in emp_map:
            emp_map[ucode] = {
                "EmpCode": ucode,
                "EmpName": "Unknown",
                "Designation": "Not specified",
                "Role": "Employee"
            }

    # Get attendance from SQL Server
    parameter_marker = "%s" if SQL_CONNECTION_MODE == "pymssql" else "?"
    placeholders = ','.join([parameter_marker] * len(target_emp_codes))
    query = f"""
        SELECT
            UserID,
            CAST(Edatetime AS DATE) AS AttendanceDate,
            MIN(Edatetime) AS FirstPunchIn,
            MAX(Edatetime) AS LastPunchOut,
            COUNT(*) AS TotalPunches,
            DATEDIFF(MINUTE, MIN(Edatetime), MAX(Edatetime)) AS WorkingMinutes,
            CONCAT(
                DATEDIFF(MINUTE, MIN(Edatetime), MAX(Edatetime)) / 60,
                ':',
                RIGHT('00' + CAST(DATEDIFF(MINUTE, MIN(Edatetime), MAX(Edatetime)) % 60 AS VARCHAR(2)), 2)
            ) AS WorkingHours
        FROM Mx_ATDEventTrn
        WHERE UserID IN ({placeholders})
          AND Edatetime >= {parameter_marker}
          AND Edatetime < {parameter_marker}
        GROUP BY UserID, CAST(Edatetime AS DATE)
        ORDER BY UserID, AttendanceDate DESC
    """
    try:
        with get_attendance_connection() as conn:
            cursor = conn.cursor()
            params = target_emp_codes + [start_date, end_date + timedelta(days=1)]
            cursor.execute(query, tuple(params))
            rows = cursor.fetchall()
            results = []
            for row in rows:
                user_id = str(row[0]).upper()
                emp_row = emp_map.get(user_id, {})
                results.append({
                    "UserID": row[0],
                    "Name": emp_row.get("EmpName", "Unknown"),
                    "Designation": emp_row.get("Designation", "Not specified"),
                    "Role": emp_row.get("Role", "Employee"),
                    "AttendanceDate": str(row[1]),
                    "FirstPunchIn": str(row[2]),
                    "LastPunchOut": str(row[3]),
                    "TotalPunches": row[4],
                    "WorkingMinutes": row[5],
                    "WorkingHours": row[6]
                })
        return results
    except pymssql.Error as e:
        raise HTTPException(status_code=500, detail=f"Attendance DB error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error: {str(e)}")

@app.get("/api/holidays", response_model=list[HolidayOut])
def get_holidays(month: Optional[str] = Query(None)):
    """
    Fetch holidays from MySQL database.
    """
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    if month:
        start_date = f"{month}-01"
        # Calculate start of next month
        year, mon = map(int, month.split('-'))
        if mon == 12:
            end_date = f"{year+1}-01-01"
        else:
            end_date = f"{year}-{mon+1:02d}-01"
        cursor.execute(
            "SELECT ID, HolidayDate, Reason, CreatedBy FROM Holidays WHERE HolidayDate >= %s AND HolidayDate < %s",
            (start_date, end_date)
        )
    else:
        cursor.execute("SELECT ID, HolidayDate, Reason, CreatedBy FROM Holidays WHERE HolidayDate >= CURDATE()")
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "id": row["ID"],
            "holiday_date": str(row["HolidayDate"]),
            "reason": row["Reason"],
            "created_by": row.get("CreatedBy")
        }
        for row in rows
    ]

@app.post("/api/holidays", response_model=HolidayOut)
def create_holiday(
    holiday: HolidayCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a holiday in MySQL."""
    if str(current_user.get("role", "")).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    conn = get_mysql_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO Holidays (HolidayDate, Reason, CreatedBy) VALUES (%s, %s, %s)",
            (holiday.holiday_date, holiday.reason, current_user["emp_code"])
        )
        conn.commit()
        holiday_id = cursor.lastrowid
        cursor.execute(
            "SELECT ID, HolidayDate, Reason, CreatedBy FROM Holidays WHERE ID = %s",
            (holiday_id,)
        )
        row = cursor.fetchone()
        return {
            "id": row[0],
            "holiday_date": str(row[1]),
            "reason": row[2],
            "created_by": row[3]
        }
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()

@app.put("/api/holidays/{holiday_id}", response_model=HolidayOut)
def update_holiday(
    holiday_id: int,
    holiday: HolidayCreate,
    current_user: dict = Depends(get_current_user)
):
    """Update a holiday date and reason."""
    if str(current_user.get("role", "")).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")

    reason = holiday.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Holiday reason is required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            "UPDATE Holidays SET HolidayDate = %s, Reason = %s WHERE ID = %s",
            (holiday.holiday_date, reason, holiday_id)
        )
        if cursor.rowcount == 0:
            cursor.execute(
                "SELECT ID, HolidayDate, Reason, CreatedBy FROM Holidays WHERE ID = %s",
                (holiday_id,)
            )
            existing = cursor.fetchone()
            if not existing:
                raise HTTPException(status_code=404, detail="Holiday not found")
        conn.commit()
        cursor.execute(
            "SELECT ID, HolidayDate, Reason, CreatedBy FROM Holidays WHERE ID = %s",
            (holiday_id,)
        )
        row = cursor.fetchone()
        return {
            "id": row["ID"],
            "holiday_date": str(row["HolidayDate"]),
            "reason": row["Reason"],
            "created_by": row.get("CreatedBy")
        }
    except HTTPException:
        conn.rollback()
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to update holiday: {error}")
    finally:
        cursor.close()
        conn.close()

@app.delete("/api/holidays/{holiday_id}")
def delete_holiday(holiday_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a holiday from MySQL."""
    if str(current_user.get("role", "")).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    conn = get_mysql_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM Holidays WHERE ID = %s", (holiday_id,))
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    if affected == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"message": "Deleted"}

if __name__ == "__main__":
    import uvicorn
    from pathlib import Path

    backend_dir = Path(__file__).resolve().parent
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(backend_dir)],
        app_dir=str(backend_dir),
    )
