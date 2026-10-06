@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  双击这个文件：给「开发用的这一份」塞一套演示数据，用来看看效果、
rem  截图、演示。不会碰日常在用的那一份（除非你选 4，或者自己指路径）。
rem
rem  直接带参数用也行，比如：
rem    演示数据.cmd --action status
rem    演示数据.cmd --running
rem    演示数据.cmd --data-dir "D:\小李\数据"
rem
rem  Python 的挑法和 启动.cmd 完全一样：PATH 里那几份可能被系统拦下，
rem  所以每个候选都先试跑一次导入，真能用的才用。
rem =====================================================================

set "PY="
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /d %%D in ("%ProgramFiles%\Python*") do if not defined PY call :try "%%~fD\python.exe"
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PY call :try "%%~fP"
if not defined PY call :try "D:\msys64\ucrt64\bin\python.exe"

if defined PY goto entry
echo.
echo   [ERROR] 没找到能用的 Python 3（原因见 启动.cmd 里的说明）。
echo.
pause
endlocal
exit /b 1


:entry
if not "%~1"=="" goto passthru

:menu
echo.
echo   小李 · 演示数据
echo   ============================================================
echo     当前目标：这份代码自己的 数据\ 目录
echo   ============================================================
echo     1  载入示例数据（你现在的数据会先存一份快照）
echo     2  还原成载入之前的样子
echo     3  只看现在有哪些数据
echo     4  载入到「现在正开着的那个小李」（比如 D:\小李 那份）
echo     0  或直接回车 = 退出
echo.
set "PICK="
set /p "PICK=  输入数字后回车："

if "%PICK%"=="" goto the_end
if "%PICK%"=="1" goto do_load
if "%PICK%"=="2" goto do_restore
if "%PICK%"=="3" goto do_status
if "%PICK%"=="4" goto do_load_running
if "%PICK%"=="0" goto the_end
goto menu


:do_load
"%PY%" "tools\演示数据.py" --action load
goto finished

:do_restore
"%PY%" "tools\演示数据.py" --action restore
goto finished

:do_status
"%PY%" "tools\演示数据.py" --action status
goto finished

:do_load_running
"%PY%" "tools\演示数据.py" --action load --running
goto finished

:passthru
"%PY%" "tools\演示数据.py" %*
goto finished


:finished
echo.
pause
goto menu

:the_end
endlocal
exit /b 0


:try
rem  只有「文件在」且「真能导入标准库」时，才采用这个 Python。
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
"%~1" -c "import json, urllib.request, http.server" >nul 2>nul
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof
