import base64
import hashlib
import hmac
import os
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Depends, Query, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
import pymssql
try:
    import pyodbc
except ImportError:
    pyodbc = None
import mysql.connector
from mysql.connector import Error as MySQLError
from datetime import datetime, timedelta, timezone
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

class HolidayCreate(BaseModel):
    holiday_date: str          # YYYY-MM-DD
    reason: str

class HolidayOut(BaseModel):
    id: int
    holiday_date: str
    reason: str
    created_by: Optional[str]

class EmployeeCreate(BaseModel):
    emp_name: str
    designation: str
    role: Literal["SuperAdmin", "Admin", "Employee"]
    emp_code: str

class EmployeeUpdate(EmployeeCreate):
    pass

class EmployeeOut(BaseModel):
    id: int
    emp_name: str
    designation: str
    role: str
    emp_code: str

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

class EmployeeAssignmentRequest(BaseModel):
    employee_ids: list[int]

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

class SupportQueryOut(BaseModel):
    id: int
    employee_emp_code: str
    employee_name: str
    manager_emp_code: str
    manager_name: str
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
        "query_text": row["QueryText"],
        "status": row["Status"],
        "image_name": row.get("ImageName"),
        "has_image": bool(row.get("HasImage")),
        "created_at": row["CreatedAt"],
        "solved_at": row.get("SolvedAt"),
        "solved_by": row.get("SolvedBy")
    }

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
        return {"emp_code": emp_code, "role": role}
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

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
            "is_manager": True
        }

    return {
        "emp_code": current_user["emp_code"],
        "role": row.get("Role") or current_user.get("role") or "User",
        "name": row.get("EmpName") or "Employee",
        "designation": row["Designation"],
        "is_manager": manager is not None
    }

@app.post("/api/support-queries", response_model=SupportQueryOut, status_code=201)
async def create_support_query(
    query_text: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user)
):
    """Create a query for the employee's assigned manager."""
    cleaned_query = query_text.strip()
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
                QueryText, ImageData, ImageName, ImageMimeType
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                assignment["EmployeeID"],
                assignment["EmpCode"],
                assignment["EmpName"],
                assignment["ManagerID"],
                assignment["Manager_empcode"],
                assignment["Manager_Name"],
                assignment["managar_unique_code"],
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
        cursor.execute(
            """
            SELECT
                ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
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
        role = str(current_user.get("role", "")).lower()
        if role in ("admin", "superadmin"):
            cursor.execute(
                """
                SELECT
                    ID, EmployeeEmpCode, EmployeeName, ManagerEmpCode, ManagerName,
                    QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
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
                    QueryText, Status, ImageName, ImageData IS NOT NULL AS HasImage,
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
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user)
):
    """SuperAdmin only: list assigned employees or search assignment candidates."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
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
                m.Manager_Name AS assigned_manager_name
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

    emp_name = employee.emp_name.strip()
    designation = employee.designation.strip()
    emp_code = employee.emp_code.strip().upper()
    if not emp_name or not designation or not emp_code:
        raise HTTPException(status_code=400, detail="All employee fields are required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            INSERT INTO EmployeeDetails (EmpName, Designation, Role, EmpCode)
            VALUES (%s, %s, %s, %s)
            """,
            (emp_name, designation, employee.role, emp_code)
        )
        conn.commit()
        return {
            "id": cursor.lastrowid,
            "emp_name": emp_name,
            "designation": designation,
            "role": employee.role,
            "emp_code": emp_code
        }
    except mysql.connector.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Employee code already exists")
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to add employee: {error}")
    finally:
        cursor.close()
        conn.close()

@app.get("/api/employees", response_model=list[EmployeeOut])
def get_employees(current_user: dict = Depends(get_current_user)):
    """List employees from EmployeeDetails."""
    if str(current_user.get("role", "")).lower() != "superadmin":
        raise HTTPException(status_code=403, detail="SuperAdmin access required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            SELECT ID, EmpName, Designation, Role, EmpCode
            FROM EmployeeDetails
            ORDER BY EmpName, ID
            """
        )
        rows = cursor.fetchall()
        return [
            {
                "id": row["ID"],
                "emp_name": row["EmpName"],
                "designation": row["Designation"],
                "role": row["Role"],
                "emp_code": row["EmpCode"]
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

    emp_name = employee.emp_name.strip()
    designation = employee.designation.strip()
    emp_code = employee.emp_code.strip().upper()
    if not emp_name or not designation or not emp_code:
        raise HTTPException(status_code=400, detail="All employee fields are required")

    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(
            """
            UPDATE EmployeeDetails
            SET EmpName = %s, Designation = %s, Role = %s, EmpCode = %s
            WHERE ID = %s
            """,
            (emp_name, designation, employee.role, emp_code, employee_id)
        )
        if cursor.rowcount == 0:
            cursor.execute("SELECT ID FROM EmployeeDetails WHERE ID = %s", (employee_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Employee not found")
        conn.commit()
        return {
            "id": employee_id,
            "emp_name": emp_name,
            "designation": designation,
            "role": employee.role,
            "emp_code": emp_code
        }
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
