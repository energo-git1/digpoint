@echo off
cd /d %~dp0
echo [1/3] git add + commit...
git add -A
git commit -m "v1.2.97: IMAP Telia investiciniai PDF priemimas, 413 fix, temos pataisymas"
echo [2/3] git push...
git push
echo [3/3] Triggering server deploy (git pull + pm2 restart)...
curl -s -X POST http://10.2.1.115:3001/api/admin/deploy
echo.
echo Done! Reload the Digpoint tab to see v1.2.97
pause
