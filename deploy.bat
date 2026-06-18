@echo off
cd /d %~dp0

echo [0/4] Auto-didinamas versijos numeris...
node -e "
  var fs=require('fs');
  var pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
  var parts=pkg.version.split('.');
  parts[2]=parseInt(parts[2]||0)+1;
  pkg.version=parts.join('.');
  fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
  console.log('  Nauja versija: v'+pkg.version);
"

for /f "tokens=*" %%v in ('node -e "var p=require('./package.json');process.stdout.write(p.version);"') do set VER=%%v

echo [1/4] git add + commit...
git add -A
git commit -m "v%VER%: deploy"

echo [2/4] git push...
git push

echo [3/4] Triggering Digpoint deploy (git pull + pm2 restart)...
curl -s -X POST http://10.2.1.115:3001/api/admin/deploy

echo [4/4] Laukiame Digpoint restart (5 sek)...
timeout /t 5 /nobreak >nul

echo [4/4] Triggering DocPoint deploy (git pull + pm2 restart)...
curl -s -X POST http://10.2.1.115:3001/api/admin/deploy-docpoint

echo.
echo Done! Reload both Digpoint and DocPoint tabs.
pause
