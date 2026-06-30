@echo off
echo Jungiuosi prie serverio 10.2.1.115...
echo Kai paklaus slaptazodzio - iveskite serverio SSH slaptazodi.
echo.
ssh -o StrictHostKeyChecking=no -t eimutis.simkus@10.2.1.115 "cd ~/digpoint && git pull && pm2 start server.js --name digpoint 2>/dev/null || pm2 restart digpoint; pm2 logs digpoint --lines 5"
echo.
pause
