<#
.SYNOPSIS
  Feeds supplier invoices into the accounts-payable queue automatically.

.DESCRIPTION
  Two sources, either or both:

    1. An Outlook folder. Set up a normal Outlook rule to move supplier
       invoice emails into it; this script pulls the PDF attachments out and
       posts them, then moves the mail to a "Processed" subfolder so the same
       invoice is never read twice.

    2. A filesystem folder. Anything dropped there -- a scan, a download, a
       file saved out of Outlook by hand -- gets posted and then moved to a
       "processed" subfolder.

  Each PDF is POSTed to /api/ap/inbound. The API hashes the bytes and
  collapses duplicates onto one row, so re-running this after a crash, or
  posting the same invoice from both sources, cannot create a second bill.

  Runs on a schedule (see -Install). Outlook COM needs Outlook running in an
  interactive session, so this must run as the signed-in user on a machine
  where Outlook is open -- not as SYSTEM, and not on a locked-out server.

.PARAMETER ApiBase
  API root. Defaults to https://api.holmgraphics.ca/api

.PARAMETER Secret
  Must match AP_INBOUND_SECRET on the API. Falls back to the
  AP_INBOUND_SECRET environment variable.

.PARAMETER OutlookFolder
  Backslash-separated path from the mailbox root, e.g.
  "darren@holmgraphics.ca\Inbox\AP Invoices". Omit to skip the Outlook source.

.PARAMETER WatchFolder
  Filesystem folder to sweep. Omit to skip the folder source.

.PARAMETER Install
  Register the scheduled task (every 10 minutes, at logon) instead of running.

.EXAMPLE
  .\ap-outlook-watcher.ps1 -OutlookFolder "darren@holmgraphics.ca\Inbox\AP Invoices" -WatchFolder "C:\AP-Inbox"

.EXAMPLE
  .\ap-outlook-watcher.ps1 -Install -OutlookFolder "darren@holmgraphics.ca\Inbox\AP Invoices"
#>

[CmdletBinding()]
param(
  [string] $ApiBase       = $(if ($env:AP_API_BASE) { $env:AP_API_BASE } else { 'https://api.holmgraphics.ca/api' }),
  [string] $Secret        = $env:AP_INBOUND_SECRET,
  [string] $OutlookFolder = $env:AP_OUTLOOK_FOLDER,
  [string] $WatchFolder   = $env:AP_WATCH_FOLDER,
  [string] $LogPath       = "$env:LOCALAPPDATA\HolmGraphics\ap-watcher.log",
  [switch] $Install,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# Extensions the API accepts. Anything else in the folder is left alone rather
# than deleted -- a stray file is someone's, not ours to throw away.
$AllowedExt = @('.pdf', '.jpg', '.jpeg', '.png')

function Write-Log {
  param([string] $Message, [string] $Level = 'INFO')
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  try {
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch {
    # A log we cannot write must never stop invoices being filed.
  }
}

function Get-MimeType {
  param([string] $Path)
  switch ([System.IO.Path]::GetExtension($Path).ToLower()) {
    '.pdf'  { 'application/pdf' }
    '.jpg'  { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.png'  { 'image/png' }
    default { 'application/octet-stream' }
  }
}

# POSTs one file. Returns $true when the API has it -- including when it says
# "duplicate", because that also means it is safely on file and the local copy
# can be moved out of the way.
function Send-Document {
  param([string] $Path, [string] $Source)

  $name = [System.IO.Path]::GetFileName($Path)

  if ($DryRun) {
    Write-Log "DRY RUN: would post '$name' from $Source"
    return $true
  }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
  } catch {
    Write-Log "Could not read '$name': $($_.Exception.Message)" 'ERROR'
    return $false
  }

  if ($bytes.Length -eq 0) {
    Write-Log "Skipping '$name': empty file" 'WARN'
    return $false
  }
  # The API rejects anything over 30MB (the Messages API base64 ceiling), so
  # there is no point spending the upload.
  if ($bytes.Length -gt 30MB) {
    Write-Log "Skipping '$name': $([math]::Round($bytes.Length/1MB,1))MB exceeds the 30MB limit" 'WARN'
    return $false
  }

  $body = @{
    filename       = $name
    content_base64 = [System.Convert]::ToBase64String($bytes)
    source         = $Source
    mime_type      = (Get-MimeType $Path)
  } | ConvertTo-Json -Compress

  try {
    $res = Invoke-RestMethod -Method Post -Uri "$ApiBase/ap/inbound" `
      -Headers @{ 'X-AP-Secret' = $Secret } `
      -ContentType 'application/json' -Body $body -TimeoutSec 120

    if ($res.duplicate) {
      Write-Log "'$name' already on file as document $($res.id)"
    } else {
      Write-Log "Posted '$name' as document $($res.id)"
    }
    return $true
  } catch {
    $status = ''
    if ($_.Exception.Response) { $status = " (HTTP $([int]$_.Exception.Response.StatusCode))" }
    Write-Log "Failed to post '$name'$status : $($_.Exception.Message)" 'ERROR'
    return $false
  }
}

# --- Filesystem source ---------------------------------------------------
function Invoke-FolderSweep {
  param([string] $Folder)

  if (-not (Test-Path $Folder)) {
    Write-Log "Watch folder '$Folder' does not exist -- skipping" 'WARN'
    return
  }

  $processed = Join-Path $Folder 'processed'
  if (-not (Test-Path $processed)) { New-Item -ItemType Directory -Path $processed -Force | Out-Null }

  $files = Get-ChildItem -Path $Folder -File | Where-Object { $AllowedExt -contains $_.Extension.ToLower() }
  if ($files.Count -eq 0) { return }

  Write-Log "Folder sweep: $($files.Count) file(s) in '$Folder'"

  foreach ($f in $files) {
    # A file still being written by a scanner or a download would post as a
    # truncated PDF. Skip anything touched in the last 20 seconds and pick it
    # up on the next run.
    if ((Get-Date) - $f.LastWriteTime -lt [TimeSpan]::FromSeconds(20)) {
      Write-Log "Skipping '$($f.Name)': still being written"
      continue
    }

    if (Send-Document -Path $f.FullName -Source 'folder') {
      if ($DryRun) { continue }
      # Collide-proof the destination: two invoices can arrive with the same
      # filename from different suppliers.
      $dest = Join-Path $processed $f.Name
      if (Test-Path $dest) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dest = Join-Path $processed ("{0}-{1}{2}" -f $f.BaseName, $stamp, $f.Extension)
      }
      try { Move-Item -Path $f.FullName -Destination $dest -Force }
      catch { Write-Log "Posted '$($f.Name)' but could not move it: $($_.Exception.Message)" 'WARN' }
    }
  }
}

# --- Outlook source ------------------------------------------------------
function Resolve-OutlookFolder {
  param($Namespace, [string] $Path)

  $parts = $Path -split '\\' | Where-Object { $_ -ne '' }
  if ($parts.Count -lt 1) { throw "OutlookFolder path is empty" }

  $current = $null
  foreach ($store in $Namespace.Folders) {
    if ($store.Name -eq $parts[0]) { $current = $store; break }
  }
  if (-not $current) {
    $available = ($Namespace.Folders | ForEach-Object { $_.Name }) -join ', '
    throw "Mailbox '$($parts[0])' not found. Available: $available"
  }

  for ($i = 1; $i -lt $parts.Count; $i++) {
    $next = $null
    foreach ($sub in $current.Folders) {
      if ($sub.Name -eq $parts[$i]) { $next = $sub; break }
    }
    if (-not $next) { throw "Folder '$($parts[$i])' not found under '$($current.Name)'" }
    $current = $next
  }
  return $current
}

function Invoke-OutlookSweep {
  param([string] $FolderPath)

  try {
    $outlook = New-Object -ComObject Outlook.Application
  } catch {
    Write-Log "Outlook is not running or COM is unavailable -- skipping the Outlook source. $($_.Exception.Message)" 'WARN'
    return
  }

  $ns     = $outlook.GetNamespace('MAPI')
  $folder = Resolve-OutlookFolder -Namespace $ns -Path $FolderPath

  # Processed mail moves here rather than being deleted or merely marked read.
  # It keeps the original email -- the covering note, the sender, the date --
  # which the PDF alone does not carry.
  $processed = $null
  foreach ($sub in $folder.Folders) {
    if ($sub.Name -eq 'Processed') { $processed = $sub; break }
  }
  if (-not $processed -and -not $DryRun) { $processed = $folder.Folders.Add('Processed') }

  $items = $folder.Items
  if ($items.Count -eq 0) { return }

  Write-Log "Outlook sweep: $($items.Count) message(s) in '$FolderPath'"

  $temp = Join-Path $env:TEMP 'hg-ap-watcher'
  if (-not (Test-Path $temp)) { New-Item -ItemType Directory -Path $temp -Force | Out-Null }

  # Iterate backwards: moving an item out re-indexes the collection, and a
  # forward loop silently skips every second message.
  for ($i = $items.Count; $i -ge 1; $i--) {
    $mail = $items.Item($i)

    try {
      if ($mail.Class -ne 43) { continue }   # olMail

      $sent = 0
      $failed = $false

      foreach ($att in $mail.Attachments) {
        $ext = [System.IO.Path]::GetExtension($att.FileName)
        if (-not $ext -or ($AllowedExt -notcontains $ext.ToLower())) { continue }
        # Inline signature images and logos ride along on almost every
        # supplier email; anything tiny is decoration, not an invoice.
        if ($att.Size -lt 8KB) { continue }

        $tempFile = Join-Path $temp $att.FileName
        try {
          $att.SaveAsFile($tempFile)
          if (Send-Document -Path $tempFile -Source 'email') { $sent++ } else { $failed = $true }
        } catch {
          Write-Log "Attachment '$($att.FileName)' from '$($mail.Subject)': $($_.Exception.Message)" 'ERROR'
          $failed = $true
        } finally {
          if (Test-Path $tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
        }
      }

      if ($sent -gt 0 -and -not $failed -and -not $DryRun) {
        $mail.Move($processed) | Out-Null
        Write-Log "Filed '$($mail.Subject)' ($sent attachment(s))"
      } elseif ($sent -eq 0 -and -not $failed) {
        # Nothing worth posting. Left in place deliberately -- moving it would
        # hide an invoice that arrived in a format we did not recognise.
        Write-Log "No usable attachment on '$($mail.Subject)' -- left in the folder" 'WARN'
      }
    } catch {
      Write-Log "Error on message $i : $($_.Exception.Message)" 'ERROR'
    } finally {
      if ($mail) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($mail) | Out-Null }
    }
  }
}

# --- Scheduled-task registration -----------------------------------------
function Install-Task {
  $script = $MyInvocation.ScriptName
  if (-not $script) { $script = $PSCommandPath }

  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
  if ($OutlookFolder) { $argLine += " -OutlookFolder `"$OutlookFolder`"" }
  if ($WatchFolder)   { $argLine += " -WatchFolder `"$WatchFolder`"" }
  if ($ApiBase)       { $argLine += " -ApiBase `"$ApiBase`"" }

  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
  $atLogon = New-ScheduledTaskTrigger -AtLogOn
  $repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
               -RepetitionInterval (New-TimeSpan -Minutes 10)
  # Interactive, not SYSTEM: Outlook COM only exists inside a signed-in
  # session with Outlook actually open.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                 -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
                 -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

  Register-ScheduledTask -TaskName 'HolmGraphics AP Watcher' `
    -Action $action -Trigger @($atLogon, $repeat) `
    -Principal $principal -Settings $settings -Force | Out-Null

  Write-Log "Scheduled task 'HolmGraphics AP Watcher' registered (every 10 minutes)."
  Write-Log "AP_INBOUND_SECRET must be set as a USER environment variable for the task to authenticate."
}

# --- Main ----------------------------------------------------------------
if ($Install) {
  Install-Task
  return
}

if (-not $Secret) {
  Write-Log "AP_INBOUND_SECRET is not set. Pass -Secret or set the environment variable." 'ERROR'
  exit 1
}
if (-not $OutlookFolder -and -not $WatchFolder) {
  Write-Log "Nothing to do: give -OutlookFolder, -WatchFolder, or both." 'ERROR'
  exit 1
}

Write-Log "AP watcher starting (api=$ApiBase)"

if ($WatchFolder)   { try { Invoke-FolderSweep  -Folder $WatchFolder }      catch { Write-Log "Folder sweep failed: $($_.Exception.Message)" 'ERROR' } }
if ($OutlookFolder) { try { Invoke-OutlookSweep -FolderPath $OutlookFolder } catch { Write-Log "Outlook sweep failed: $($_.Exception.Message)" 'ERROR' } }

Write-Log "AP watcher done"
