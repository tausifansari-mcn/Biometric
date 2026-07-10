@echo off
title Biometric Backend (Port 8000)
cd /d "c:\Users\MAS60358\Desktop\Biometric\attendance-frontend\backend"
:restart
echo [%date% %time%] Starting Biometric Backend...
"C:\Python314\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000
echo [%date% %time%] Backend stopped. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart
