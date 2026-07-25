@echo off
echo =========================================
echo    WebJavaIDE - One-Time Setup Script
echo =========================================
echo.

echo [1/3] Checking Node.js installation...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed or not in PATH! Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
echo Node.js is installed.

echo.
echo [2/3] Checking Java JDK installation...
javac -version >nul 2>&1
if %errorlevel% neq 0 (
    echo Warning: javac was not found in standard PATH.
    echo Please ensure Java JDK is installed and JAVA_HOME is set.
) else (
    echo Java JDK is installed.
)

echo.
echo [3/3] Installing Node.js dependencies...
call npm install
if %errorlevel% neq 0 (
    echo Error: npm install failed.
    pause
    exit /b 1
)

echo.
echo =========================================
echo    Setup completed successfully!
echo    Run 'npm start' to launch the server.
echo    Then open http://localhost:5000
echo =========================================
echo.
pause
