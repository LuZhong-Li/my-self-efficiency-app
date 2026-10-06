@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  小李 · 一键自检
rem
rem  自己在一个临时数据目录里起服务跑一遍检查，不会碰你正在用的数据。
rem  找一个能用的 Python 的逻辑和 启动.cmd 一样（这台电脑 PATH 里排第一的
rem  msys2 那份被「智能应用控制」挡着，用不了）。
rem =====================================================================

set "PY="

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /d %%D in ("%ProgramFiles%\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PY call :try "%%~fP"
if not defined PY call :try "D:\msys64\ucrt64\bin\python.exe"

if defined PY goto start

echo.
echo   [ERROR] No usable Python 3 found on this computer.
echo.
pause
endlocal
exit /b 1

:start
echo   Python: %PY%
echo.
"%PY%" "tests\自检.py"

echo.
pause
endlocal
exit /b 0


:try
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
"%~1" -c "import http.server, json, mimetypes, webbrowser, urllib.request" >nul 2>nul
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof
