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
import pyodbc
import mysql.connector
from mysql.connector import Error as MySQLError
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional
import jwt

load_dotenv()

app = FastAPI(title="Attendance + Holiday API (Multi-DB)")

# CORS — comma-separated origins from env, e.g. "https://foo.vercel.app,http://localhost:3000"
_raw_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000")
CORS_ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://https://biometric-78e6.vercel.app/"
    ],
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

# ---------- Helper: SQL Server Connection (unchanged) ----------
def get_attendance_connection():
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
    """Save a new employee password in EmployeeDetails.Password."""
    emp_code = request.emp_code.strip().upper()
    if not emp_code:
        raise HTTPException(status_code=400, detail="Employee code is required")
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    conn = get_mysql_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "UPDATE EmployeeDetails SET Password = %s WHERE EmpCode = %s",
            (hash_password(request.password), emp_code)
        )
        if cursor.rowcount == 0:
            conn.rollback()
            raise HTTPException(status_code=404, detail="Employee code not found")
        conn.commit()
        return {"message": "Password updated successfully. You can now sign in."}
    except HTTPException:
        raise
    except MySQLError as error:
        conn.rollback()
        raise HTTPException(status_code=400, detail=f"Unable to update password: {error}")
    finally:
        cursor.close()
        conn.close()

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
    """List queries assigned to the signed-in manager."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if not manager:
            raise HTTPException(status_code=403, detail="Manager access required")
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
    """Mark one of the signed-in manager's assigned queries as solved."""
    conn = get_mysql_connection()
    cursor = conn.cursor(dictionary=True)
    try:
        manager = get_manager_for_user(cursor, current_user["emp_code"])
        if not manager:
            raise HTTPException(status_code=403, detail="Manager access required")
        cursor.execute(
            """
            UPDATE SupportQueries
            SET Status = 'Solved', SolvedAt = CURRENT_TIMESTAMP, SolvedBy = %s
            WHERE ID = %s AND ManagerID = %s AND Status = 'Open'
            """,
            (current_user["emp_code"], query_id, manager["ID"])
        )
        if cursor.rowcount == 0:
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
    """Return an attached image to its employee or assigned manager."""
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

        is_employee = row["EmployeeEmpCode"].upper() == current_user["emp_code"].upper()
        manager = None if is_employee else get_manager_for_user(cursor, current_user["emp_code"])
        is_assigned_manager = bool(manager and manager["ID"] == row["ManagerID"])
        if not is_employee and not is_assigned_manager:
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

@app.post("/api/employees", response_model=EmployeeOut, status_code=201)
def create_employee(
    employee: EmployeeCreate,
    current_user: dict = Depends(get_current_user)
):
    """Admin only: add an employee. ID is generated by MySQL."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")

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
    """Admin only: list employees from EmployeeDetails."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")

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
    """Admin only: update an EmployeeDetails row."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
        raise HTTPException(status_code=403, detail="Admin access required")

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
    placeholders = ','.join('?' * len(target_emp_codes))
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
          AND Edatetime >= ?
          AND Edatetime < ?
        GROUP BY UserID, CAST(Edatetime AS DATE)
        ORDER BY UserID, AttendanceDate DESC
    """
    try:
        with get_attendance_connection() as conn:
            cursor = conn.cursor()
            params = target_emp_codes + [start_date, end_date + timedelta(days=1)]
            cursor.execute(query, params)
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
    except pyodbc.Error as e:
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
    """Admin only: create a holiday in MySQL."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
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
    """Admin only: update a holiday date and reason."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
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
    """Admin only: delete a holiday from MySQL."""
    if str(current_user["role"]).lower() not in ("admin", "superadmin"):
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
