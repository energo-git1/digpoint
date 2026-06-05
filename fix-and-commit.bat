@echo off
cd /d "%~dp0"

echo Ieškau git...
for /f "delims=" %%i in ('where git 2^>nul') do set GIT="%%i" & goto :found
for /f "delims=" %%i in ('dir /b /s "C:\Users\eimutis.simkus\AppData\Local\GitHubDesktop\*.exe" 2^>nul ^| findstr /i "\\git\\cmd\\git.exe"') do set GIT="%%i" & goto :found
for /f "delims=" %%i in ('dir /b /s "C:\Program Files\Git\cmd\git.exe" 2^>nul') do set GIT="%%i" & goto :found
echo GIT NERASTAS. Skambink Eimučiui.
pause
exit /b 1

:found
echo Rastas: %GIT%
echo.

echo Šalinu git užraktą...
del /f .git\index.lock 2>nul

echo Ruošiu failus...
%GIT% add energolt-kasimo.user.js server.js package.json
%GIT% restore public\index.html

echo Darau commit...
%GIT% commit -m "v1.5.58: SAV parsavimas, municipality ištraukimas, ESO retry ciklas"

echo Siunčiu į GitHub...
%GIT% push

echo.
echo === ATLIKTA. Serveris atsistatys per ~1 min. ===
pause
