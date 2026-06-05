@echo off
cd /d "%~dp0"
echo Salinu git uzrakta...
del /f .git\index.lock 2>nul
echo Ruošiu failus...
git add energolt-kasimo.user.js server.js package.json
git restore public\index.html
echo Darau commit...
git commit -m "v1.5.58: SAV parsavimas, municipality ištraukimas, ESO retry ciklas"
echo Siunciu i GitHub...
git push
echo.
echo ATLIKTA. Galite uždaryti langą.
pause
