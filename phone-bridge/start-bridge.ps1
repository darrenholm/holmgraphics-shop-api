$ErrorActionPreference = 'Continue'
$logFile = 'C:\holmgraphics\phone-bridge\bridge.log'
Add-Content $logFile "`n=== phone-bridge launch $(Get-Date) ==="
Set-Location C:\holmgraphics\phone-bridge
& 'C:\Program Files\nodejs\node.exe' server.js *>> $logFile
