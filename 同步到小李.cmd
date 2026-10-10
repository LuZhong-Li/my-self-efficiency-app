@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =====================================================================
rem  把这份代码同步到「日常在用的那一份」。
rem
rem  这个仓库只用来开发和推送；平时双击使用的是 %TARGET% 那一份，
rem  它带着你自己的数据。
rem
rem  只同步「用得上的东西」，两类文件刻意跳过：
rem    1. %TARGET%\数据 —— 你的任务、记录、备份，绝不能动；
rem    2. 只有仓库才需要的东西 —— .git、.gitignore、.gitattributes、
rem       以及本文件自己（在那边没有意义）；
rem    3. 演示数据工具（演示数据.cmd + tools\）—— 那是给开发版演示、截图用的，
rem       日常在用的那份不需要它，免得误点到把自己真实数据换成演示数据。
rem    4. 小李.ico —— 日常那份的图标用的是你自己的图（tools\图标.py
rem       --图片 某张图 --输出 目标路径 生成），仓库里这份是默认的玻璃图标。
rem       同步过去会把你的图标顶掉，所以这个文件也跳过。
rem =====================================================================

set "TARGET=D:\小李"

rem  %~dp0 结尾带一个反斜杠，直接 "%~dp0" 拿去当 robocopy 的源目录会踩坑：
rem  robocopy 用的是 C 运行时的参数解析，字符串里 \" 算「转义的双引号」，
rem  于是那个引号没闭合、后面的参数全被吞成一个。给源目录末尾补一个点
rem  （"D:\小李。." 这种写法）就没有结尾反斜杠了，参数才分得清。
rem  下面 /XD 那几处是「拼路径」，反过来要用带反斜杠的原值。
set "SRC=%~dp0"
set "SRCQ=%~dp0."

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

robocopy "%SRCQ%" "%TARGET%" /E ^
  /XD "%SRC%数据" "%SRC%.git" "%SRC%__pycache__" "%SRC%tools" ^
  /XF *.pyc *.log *.tmp .gitignore .gitattributes 同步到小李.cmd 演示数据.cmd 小李.ico ^
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
