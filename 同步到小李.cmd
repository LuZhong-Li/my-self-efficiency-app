@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  把这份代码同步到「日常在用的那一份」。
rem
rem  这个仓库（D:\自用APP管理）只用来开发和推送；
rem  平时双击使用的是 D:\小李 那一份，它带着你自己的数据。
rem
rem  只同步代码，绝不碰 %TARGET%\数据 —— 你的任务、记录、备份都安全。
rem =====================================================================

set "TARGET=D:\小李"

if not exist "%TARGET%" (
  echo.
  echo   [ERROR] 找不到 %TARGET%
  echo   先把这份代码复制一份到 %TARGET% ，或者改一下本文件里的 TARGET。
  echo.
  pause
  exit /b 1
)

echo   从  %~dp0
echo   到  %TARGET%
echo.

robocopy "%~dp0" "%TARGET%" /E ^
  /XD "%~dp0数据" "%~dp0.git" "%~dp0__pycache__" ^
  /XF *.pyc *.log *.tmp ^
  /NFL /NDL /NJH /NJS /NP

if %ERRORLEVEL% GEQ 8 (
  echo.
  echo   [ERROR] 同步失败，看上面的提示。
  echo.
  pause
  exit /b 1
)

echo.
echo   同步完成。你的数据（%TARGET%\数据）没有动过。
echo.
pause
endlocal
exit /b 0
