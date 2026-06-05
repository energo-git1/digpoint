@echo off
cd /d "%~dp0"

echo Uzdarau GitHub Desktop...
taskkill /f /im GitHubDesktop.exe 2>nul
timeout /t 2 /nobreak >nul

echo Salinu uzraktus...
del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul
del /f /q ".git\refs\heads\main.lock" 2>nul
del /f /q ".git\objects\maintenance.lock" 2>nul

echo Ieškau git...
set GIT=
for /f "delims=" %%G in ('dir /s /b "%LOCALAPPDATA%\GitHubDesktop\git.exe" 2^>nul') do if not defined GIT set GIT=%%G
if not defined GIT for /f "delims=" %%G in ('dir /s /b "%LOCALAPPDATA%\GitHubDesktop\cmd\git.exe" 2^>nul') do if not defined GIT set GIT=%%G
if not defined GIT if exist "C:\Program Files\Git\cmd\git.exe" set GIT=C:\Program Files\Git\cmd\git.exe
if not defined GIT for /f "delims=" %%G in ('where git 2^>nul') do if not defined GIT set GIT=%%G

if not defined GIT (
    echo.
    echo GIT NERASTAS. Bandau per PowerShell...
    powershell -ExecutionPolicy Bypass -Command "& { Set-Location '%~dp0'; $g = (Get-ChildItem $env:LOCALAPPDATA\GitHubDesktop -Recurse -Filter git.exe -EA SilentlyContinue | Where { $_.FullName -match 'cmd.git' } | Select -First 1).FullName; if($g){Write-Host \"Rastas: $g\"; & $g push origin main} else {Write-Host 'Git nerastas!'} }"
    goto :end
)

echo Rastas: %GIT%
echo Stumiame i GitHub...
"%GIT%" push origin main

:end
echo.
echo === BAIGTA ===
pause
