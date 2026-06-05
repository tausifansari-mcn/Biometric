import os
from fastapi import FastAPI, HTTPException, status, Header, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pyodbc
from datetime import datetime, timedelta
from typing import Optional
import jwt

app = FastAPI(title="Attendance API", description="Employee Attendance Management")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = "your-secret-key-change-in-production"
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 8

SQL_CONFIG = {
    'server': '172.10.10.146',
    'port': 1433,
    'database': 'NCOSEC',
    'username': 'shivamg',
    'password': 'Noida$1234',
    'driver': '{ODBC Driver 17 for SQL Server}'
}

class LoginRequest(BaseModel):
    user_id: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str
    user_id: str

class AttendanceRecord(BaseModel):
    UserID: str
    Name: str
    AttendanceDate: str
    FirstPunchIn: str
    LastPunchOut: str
    TotalPunches: int
    WorkingMinutes: int
    WorkingHours: str

def get_db_connection():
    conn_str = (
        f"DRIVER={SQL_CONFIG['driver']};"
        f"SERVER={SQL_CONFIG['server']},{SQL_CONFIG['port']};"
        f"DATABASE={SQL_CONFIG['database']};"
        f"UID={SQL_CONFIG['username']};"
        f"PWD={SQL_CONFIG['password']};"
        "TrustServerCertificate=yes;"
        "Encrypt=no;"
    )
    return pyodbc.connect(conn_str)

def create_access_token(user_id: str, expires_delta: Optional[timedelta] = None):
    to_encode = {"sub": user_id}
    expire = datetime.utcnow() + (expires_delta or timedelta(hours=8))
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(authorization: Optional[str] = Header(None)) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid authorization header format")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token: missing subject")
        return user_id
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

@app.get("/")
def root():
    return {"message": "Attendance API is running"}

@app.post("/api/login", response_model=Token)
def login(request: LoginRequest):
    expected_password = f"{request.user_id}@123"
    if request.password != expected_password:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    access_token = create_access_token(request.user_id)
    return {"access_token": access_token, "token_type": "bearer", "user_id": request.user_id}

@app.get("/api/attendance", response_model=list[AttendanceRecord])
def get_attendance(
    current_user: str = Depends(get_current_user),
    month: Optional[str] = Query(None, description="Format: YYYY-MM, defaults to current month")
):
    # If no month provided, use current month
    if not month:
        now = datetime.now()
        month = now.strftime("%Y-%m")
    
    # Build first and last day of the month
    year, mon = map(int, month.split('-'))
    start_date = datetime(year, mon, 1)
    if mon == 12:
        end_date = datetime(year+1, 1, 1) - timedelta(days=1)
    else:
        end_date = datetime(year, mon+1, 1) - timedelta(days=1)
    
    query = """
        SELECT 
            a.UserID,
            u.Name,
            CAST(a.Edatetime AS DATE) AS AttendanceDate,
            MIN(a.Edatetime) AS FirstPunchIn,
            MAX(a.Edatetime) AS LastPunchOut,
            COUNT(*) AS TotalPunches,
            DATEDIFF(MINUTE, MIN(a.Edatetime), MAX(a.Edatetime)) AS WorkingMinutes,
            CONCAT(
                DATEDIFF(MINUTE, MIN(a.Edatetime), MAX(a.Edatetime)) / 60,
                ':',
                RIGHT('00' + CAST(DATEDIFF(MINUTE, MIN(a.Edatetime), MAX(a.Edatetime)) % 60 AS VARCHAR(2)), 2)
            ) AS WorkingHours
        FROM Mx_ATDEventTrn a
        INNER JOIN Mx_UserMst u ON a.UserID = u.UserID
        WHERE a.UserID = ? 
          AND a.Edatetime >= ?
          AND a.Edatetime < ?
        GROUP BY a.UserID, u.Name, CAST(a.Edatetime AS DATE)
        ORDER BY AttendanceDate DESC
    """
    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, (current_user, start_date, end_date + timedelta(days=1)))
            rows = cursor.fetchall()
            results = []
            for row in rows:
                results.append({
                    "UserID": row[0],
                    "Name": row[1],
                    "AttendanceDate": str(row[2]),
                    "FirstPunchIn": str(row[3]),
                    "LastPunchOut": str(row[4]),
                    "TotalPunches": row[5],
                    "WorkingMinutes": row[6],
                    "WorkingHours": row[7]
                })
        return results
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)