import base64
import hashlib
import hmac
import os
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
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
    role: Literal["Admin", "Employee"]
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
    cursor.close()
    conn.close()

    if not row:
        raise HTTPException(status_code=401, detail="Invalid credentials")
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
    cursor.close()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Employee not found")

    return {
        "emp_code": current_user["emp_code"],
        "role": row.get("Role") or current_user.get("role") or "User",
        "name": row.get("EmpName") or "Employee",
        "designation": row["Designation"]
    }

@app.post("/api/employees", response_model=EmployeeOut, status_code=201)
def create_employee(
    employee: EmployeeCreate,
    current_user: dict = Depends(get_current_user)
):
    """Admin only: add an employee. ID is generated by MySQL."""
    if str(current_user["role"]).lower() != "admin":
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
    if str(current_user["role"]).lower() != "admin":
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
    if str(current_user["role"]).lower() != "admin":
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
    month: Optional[str] = Query(None)
):
    """
    Fetch attendance records from the SQL Server for the given month.
    Returns Name from MySQL database.
    """
    emp_code = current_user["emp_code"]
    if not month:
        month = datetime.now().strftime("%Y-%m")
    year, mon = map(int, month.split('-'))
    start_date = datetime(year, mon, 1)
    if mon == 12:
        end_date = datetime(year+1, 1, 1) - timedelta(days=1)
    else:
        end_date = datetime(year, mon+1, 1) - timedelta(days=1)

    # Get employee name from MySQL
    try:
        emp_conn = get_mysql_connection()
        emp_cursor = emp_conn.cursor(dictionary=True)
        emp_cursor.execute(
            "SELECT EmpName, Designation, Role FROM EmployeeDetails WHERE EmpCode = %s",
            (emp_code,)
        )
        emp_row = emp_cursor.fetchone()
        emp_conn.close()
        employee_name = emp_row["EmpName"] if emp_row else "Unknown"
        employee_designation = emp_row["Designation"] if emp_row else "Not specified"
        employee_role = emp_row["Role"] if emp_row and emp_row["Role"] else "Employee"
    except Exception as e:
        employee_name = "Unknown"
        employee_designation = "Not specified"
        employee_role = "Employee"
        print(f"Error fetching employee name: {e}")

    # Get attendance from SQL Server
    query = """
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
        WHERE UserID = ?
          AND Edatetime >= ?
          AND Edatetime < ?
        GROUP BY UserID, CAST(Edatetime AS DATE)
        ORDER BY AttendanceDate DESC
    """
    try:
        with get_attendance_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (emp_code, start_date, end_date + timedelta(days=1)))
            rows = cursor.fetchall()
            results = []
            for row in rows:
                results.append({
                    "UserID": row[0],
                    "Name": employee_name,
                    "Designation": employee_designation,
                    "Role": employee_role,
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
    if str(current_user["role"]).lower() != "admin":
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
    if str(current_user["role"]).lower() != "admin":
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
    if str(current_user["role"]).lower() != "admin":
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

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=["backend"],
        app_dir="backend",
    )
