@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  双击这个文件启动；关掉黑窗口 = 停止程序。
rem
rem  这里有两处不能随便改：
rem
rem  1) chcp 65001 不能删。下面要启动的文件名「服务.py」是中文，而这个
rem     批处理文件本身按 UTF-8 保存；只有把控制台切到 UTF-8，cmd 才能
rem     正确读到那串中文文件名。
rem
rem  2) 不要直接相信 PATH 里的 python。这台电脑的 PATH 里排在前面的是
rem     D:\msys64\ucrt64\bin\python.exe，但系统开着「智能应用控制」，
rem     会拦掉那份 Python 未签名的 .pyd 文件，连 http.server 都导不进来。
rem     所以下面每个候选都要先试跑一次导入，真能用的才用。
rem =====================================================================

set "PY="

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /d %%D in ("%ProgramFiles%\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PY call :try "%%~fP"
if not defined PY call :try "D:\msys64\ucrt64\bin\python.exe"

if defined PY goto start

echo.
echo   [ERROR] No usable Python 3 found on this computer.
echo   A usable Python must be able to: import http.server, json
echo.
echo   Install Python 3 from python.org, then run this file again.
echo.
pause
endlocal
exit /b 1


:start
if not exist "app\服务.py" goto noentry
echo   Python: %PY%
echo.
"%PY%" "app\服务.py" %*
if not errorlevel 1 goto done

echo.
echo   [ERROR] The service stopped with an error. Details are above.
echo.
pause

:done
endlocal
exit /b 0


:noentry
echo.
echo   [ERROR] app\服务.py not found.
echo   If that file name above looks garbled, your console code page is not
echo   UTF-8. Run  chcp 65001  in this window, then try again.
echo.
pause
endlocal
exit /b 1


:try
rem  只有「文件在」且「真能导入服务要用的模块」时，才采用这个 Python。
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
"%~1" -c "import http.server, json, mimetypes, webbrowser, urllib.request" >nul 2>nul
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof
