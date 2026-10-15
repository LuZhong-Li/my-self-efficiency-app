@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  小李 · 调试启动（排错用）
rem
rem  和 启动.cmd 的区别只有一个：这个是**带控制台**的。
rem     · 用 python.exe 前台跑，控制台窗口留着；
rem     · 不带 --desktop，走浏览器模式（界面照旧，但你能看见全部输出）；
rem     · 关掉控制台窗口 = 停止程序。
rem
rem  什么时候用它：
rem     · 双击 启动.cmd 没反应 / 窗口出不来 —— 这里能看见报错原文；
rem     · 想确认端口、数据文件路径、备份目录这些启动信息；
rem     · 平时不用它：平常双击 启动.cmd，不弹控制台。
rem
rem  另外：不带控制台跑时（启动.cmd 走 pythonw），print 的输出会追加到
rem  数据\日志\console.log，那份也留着，方便事后回看。
rem
rem  找 Python 的逻辑和 启动.cmd / 自检.cmd 一模一样（这台电脑 PATH 里排第一
rem  的 msys2 那份被「智能应用控制」挡着，用不了），所以三处是一字不差的。
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
echo   （调试模式：带控制台、浏览器模式排错。关掉这个窗口 = 停止程序。）
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
