Set-Location $PSScriptRoot

Write-Host "Salinu uzraktus..." -ForegroundColor Yellow
Remove-Item ".git\index.lock" -Force -ErrorAction SilentlyContinue
Remove-Item ".git\HEAD.lock" -Force -ErrorAction SilentlyContinue
Remove-Item ".git\refs\heads\main.lock" -Force -ErrorAction SilentlyContinue
Write-Host "Uzraktai salinti." -ForegroundColor Green

# Ieškome git
$git = (Get-Command git -ErrorAction SilentlyContinue)?.Source
if (-not $git) {
    $git = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop" -Recurse -Filter "git.exe" -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -like "*\git\cmd\git.exe" } |
           Select-Object -First 1 -ExpandProperty FullName
}
if (-not $git) {
    $git = "C:\Program Files\Git\cmd\git.exe"
    if (-not (Test-Path $git)) { Write-Host "GIT NERASTAS!" -ForegroundColor Red; Read-Host; exit 1 }
}

Write-Host "Git rastas: $git" -ForegroundColor Cyan
Write-Host "Stumiame i GitHub..." -ForegroundColor Yellow
& $git push origin main

Write-Host ""
Write-Host "=== ATLIKTA. Serveris atsistatys per ~1 min. ===" -ForegroundColor Green
Read-Host "Spausk Enter uzdaryti"
