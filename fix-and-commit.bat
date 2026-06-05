@echo off
cd /d "%~dp0"

:: Randa git per GitHub Desktop
set GIT=
for /f "delims=" %%G in ('dir /s /b "%LOCALAPPDATA%\GitHubDesktop\git.exe" 2^>nul') do if not defined GIT set GIT=%%G
if not defined GIT for /f "delims=" %%G in ('where git 2^>nul') do if not defined GIT set GIT=%%G
if not defined GIT (echo GIT NERASTAS & pause & exit /b 1)

:: Salina uzraktus
del /f /q ".git\index.lock" 2>nul
del /f /q ".git\HEAD.lock" 2>nul

:: Padidina versija package.json
node -e "var f='package.json',p=JSON.parse(require('fs').readFileSync(f));var v=p.version.split('.');v[2]=+v[2]+1;p.version=v.join('.');require('fs').writeFileSync(f,JSON.stringify(p,null,2));console.log('Versija: v'+p.version);"

:: Gauna nauja versija
for /f "delims=" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VER=%%v

:: Prideda VISUS failus (reset index + re-add)
"%GIT%" reset HEAD -- . 2>nul
"%GIT%" add server.js package.json public\index.html energolt-kasimo.user.js .gitignore 2>nul
"%GIT%" status

echo.
echo Daromas commit v%VER%...
"%GIT%" commit -m "v%VER%: IMAP QP dekodavimas UTF-8, Kauno sav. busenos logavimas"

echo Siunčiama į GitHub...
"%GIT%" push

echo Trigerinamas serverio deploy...
curl -s -X POST http://10.2.1.115:3001/api/admin/deploy

echo.
echo === ATLIKTA v%VER% ===
pause
