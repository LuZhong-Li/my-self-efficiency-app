@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  双击启动。默认开「小李」自己的窗口，关掉窗口 = 退出程序。
rem
rem  还会看到黑窗口的两种情形（都是有意的）：
rem    a) 没装 pywebview  → 退回浏览器模式，控制台就是关程序的开关；
rem    b) 没有 pythonw.exe → 用 python.exe 跑，同样要靠控制台关。
rem  排错请看日志：启动-调试.cmd（带控制台）。
rem
rem  两处不能随便改：
rem
rem  1) chcp 65001 不能删。要启动的文件名「服务.py」是中文，本文件按 UTF-8
rem     保存；只有控制台切到 UTF-8，cmd 才读得对那串中文文件名。
rem
rem  2) 不要直接相信 PATH 里的 python。这台机器 PATH 里排第一的是
rem     D:\msys64\ucrt64\bin\python.exe，但系统开着「智能应用控制」，
rem     会拦掉那份 Python 的 .pyd，连 http.server 都导不进来。
rem     所以每个候选都要先试跑一次导入，真能用的才用。
rem
rem  3) 探测到 Python 之后还要看两件事才决定跑法（见 :start）：
rem     有没有 pywebview（有没有自己的窗口）、有没有 pythonw.exe
rem     （弹不弹黑窗口）。缺哪个就退哪一档，双击永远能用。
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

rem  pythonw.exe 就在 python.exe 旁边（同一个 Python 安装目录里）。
set "PYW="
for %%D in ("%PY%") do if exist "%%~dpDpythonw.exe" set "PYW=%%~dpDpythonw.exe"

rem  有没有 pywebview —— 有才能开小李自己的窗口。
set "HASWV="
"%PY%" -c "import webview" >nul 2>nul
if not errorlevel 1 set "HASWV=1"

if not defined HASWV goto browser
if not defined PYW goto bareconsole

rem  两样都有：pythonw 跑桌面窗口模式，双击后不出现控制台窗口。
echo   模式: 桌面窗口（没有控制台）
start "" "%PYW%" "app\服务.py" --desktop %*
endlocal
exit /b 0

:bareconsole
echo   模式: 桌面窗口 + 控制台（没有 pythonw.exe）
echo   控制台留着 = 关掉它即停程序。
"%PY%" "app\服务.py" --desktop %*
if not errorlevel 1 goto done

echo.
echo   [ERROR] The service stopped with an error. Details are above.
echo.
pause
goto done

:browser
echo   模式: 浏览器（没装 pywebview）
echo   想换成自己的窗口，装一次：
echo     "%PY%" -m pip install pywebview
echo   控制台留着 = 关掉它即停程序。
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
