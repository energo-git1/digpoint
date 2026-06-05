@echo off
cd /d "%~dp0"

echo Salinu visus git uzraktus...
del /f .git\index.lock 2>nul
del /f .git\HEAD.lock 2>nul
del /f .git\refs\heads\main.lock 2>nul
del /f .git\packed-refs.lock 2>nul
echo Uzraktai salinti.

echo Ieškau git...
for /f "delims=" %%i in ('where git 2^>nul') do set GIT="%%i" & goto :found
for /f "delims=" %%i in ('dir /s /b "%LOCALAPPDATA%\GitHubDesktop\app-*\resources\app\git\cmd\git.exe" 2^>nul') do set GIT="%%i" & goto :found
for /f "delims=" %%i in ('dir /s /b "C:\Program Files\Git\cmd\git.exe" 2^>nul') do set GIT="%%i" & goto :found
echo GIT NERASTAS.
pause
exit /b 1

:found
echo Git rastas: %GIT%
%GIT% push origin main
echo.
echo === ATLIKTA. Serveris atsistatys per ~1 min. ===
pause
