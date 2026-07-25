Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "   WebJavaIDE - One-Time Setup Script    " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/3] Checking Node.js installation..." -ForegroundColor Yellow
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = node -v
    Write-Host "Node.js is installed ($nodeVer)" -ForegroundColor Green
} else {
    Write-Host "Error: Node.js is not installed or not in PATH. Please install Node.js from https://nodejs.org/" -ForegroundColor Red
    Exit 1
}

Write-Host ""
Write-Host "[2/3] Checking Java JDK installation..." -ForegroundColor Yellow
if (Get-Command javac -ErrorAction SilentlyContinue) {
    $javaVer = javac -version 2>&1
    Write-Host "Java JDK is installed ($javaVer)" -ForegroundColor Green
} elseif ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\javac.exe")) {
    Write-Host "Java JDK found at $env:JAVA_HOME" -ForegroundColor Green
} else {
    Write-Host "Warning: javac was not found in PATH or JAVA_HOME. Ensure Java JDK 11+ is installed." -ForegroundColor Red
}

Write-Host ""
Write-Host "[3/3] Installing Node.js dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "   Setup completed successfully!         " -ForegroundColor Green
    Write-Host "   Run 'npm start' to launch the server. " -ForegroundColor Green
    Write-Host "   Then open http://localhost:5000       " -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
} else {
    Write-Host "Error: npm install failed." -ForegroundColor Red
    Exit 1
}
