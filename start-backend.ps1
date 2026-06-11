# Attendance Backend Startup Script
# Run this once after system restart, or set it in Task Scheduler to auto-run at login.

$BackendDir = "$PSScriptRoot\attendance-frontend\backend"
$CloudflaredExe = "$PSScriptRoot\cloudflared.exe"
$LogDir = "$PSScriptRoot\logs"

# Create logs folder
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Kill any old processes on port 8000
$old = Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
if ($old) {
    Stop-Process -Id $old.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
}

# Start uvicorn backend
Write-Host "Starting backend..." -ForegroundColor Cyan
$uvicorn = Start-Process python -ArgumentList "-m uvicorn main:app --host 0.0.0.0 --port 8000" `
    -WorkingDirectory $BackendDir `
    -RedirectStandardOutput "$LogDir\uvicorn.log" `
    -RedirectStandardError "$LogDir\uvicorn-err.log" `
    -PassThru -WindowStyle Hidden
Write-Host "Backend started (PID $($uvicorn.Id))"

# Wait for backend to be ready
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep 1
    try {
        $r = Invoke-WebRequest http://localhost:8000/health -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}
if (!$ready) { Write-Host "Backend failed to start. Check logs\uvicorn-err.log" -ForegroundColor Red; exit 1 }
Write-Host "Backend is healthy" -ForegroundColor Green

# Start cloudflared tunnel and capture URL
Write-Host "Starting tunnel..." -ForegroundColor Cyan
$tunnelLog = "$LogDir\cloudflared.log"
$tunnel = Start-Process $CloudflaredExe -ArgumentList "tunnel --url http://localhost:8000 --no-autoupdate" `
    -RedirectStandardError $tunnelLog `
    -PassThru -WindowStyle Hidden

# Wait for tunnel URL
$tunnelUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 1
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $tunnelUrl = $Matches[0]
            break
        }
    }
}

if (!$tunnelUrl) { Write-Host "Tunnel failed to start." -ForegroundColor Red; exit 1 }
Write-Host "Tunnel URL: $tunnelUrl" -ForegroundColor Green

# Update Vercel environment variable
Write-Host "Updating Vercel..." -ForegroundColor Cyan
Set-Location "$PSScriptRoot\attendance-frontend"
$tunnelUrl | npx vercel env rm REACT_APP_API_BASE_URL production --yes 2>$null
$tunnelUrl | npx vercel env add REACT_APP_API_BASE_URL production 2>&1 | Out-Null
npx vercel --prod 2>&1 | Out-Null
Write-Host "Vercel redeployed with new URL" -ForegroundColor Green

Write-Host ""
Write-Host "======================================" -ForegroundColor Yellow
Write-Host " All systems running!" -ForegroundColor Yellow
Write-Host " Frontend: https://biometric-b9xd.vercel.app" -ForegroundColor Yellow
Write-Host " Backend:  $tunnelUrl" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Keep this window open (or minimise it). Press Ctrl+C to stop."
Wait-Process -Id $uvicorn.Id
