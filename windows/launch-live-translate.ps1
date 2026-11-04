param(
  [ValidateSet('Start', 'Install', 'Update')]
  [string]$Action = 'Start',
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$AppName = 'Live Translate'
$GitHubRepo = if ($env:LIVE_TRANSLATE_GITHUB_REPO) { $env:LIVE_TRANSLATE_GITHUB_REPO } else { 'DorelRoata/LiveTranslation' }
$DashboardUrl = 'https://localhost:5173'
$InstallDir = Join-Path $env:LOCALAPPDATA 'LiveTranslation-App'
$ConfigDir = Join-Path $env:APPDATA 'LiveTranslation'
$RuntimeCacheDir = Join-Path $env:LOCALAPPDATA 'LiveTranslation\node-runtime'
$NodeVersion = 'v22.14.0'
$NodeZipName = "node-$NodeVersion-win-x64"
$NodeDownloadUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZipName.zip"

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

function Show-Dialog {
  param(
    [string]$Message,
    [string]$Title = 'Live Translate',
    [string]$Buttons = 'OK',
    [string]$Icon = 'Information'
  )
  if ($env:LIVE_TRANSLATE_DRY_RUN -eq '1') {
    Write-Output "[$Title] $Message"
    return 'OK'
  }
  $btnEnum = [System.Windows.Forms.MessageBoxButtons]::$Buttons
  $iconEnum = [System.Windows.Forms.MessageBoxIcon]::$Icon
  $result = [System.Windows.Forms.MessageBox]::Show($Message, $Title, $btnEnum, $iconEnum)
  return $result.ToString()
}

function Get-RunningInstance {
  try {
    $code = @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Net.Security;
public class TrustAllCerts {
  public static void Enable() {
    ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
  }
}
"@
    if (-not ('TrustAllCerts' -as [type])) {
      Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
    }
    [TrustAllCerts]::Enable()
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $resp = Invoke-RestMethod -Uri "$DashboardUrl/api/instance" -TimeoutSec 2 -ErrorAction Stop
    if ($resp -and $resp.application -eq 'live-translate') {
      return $resp
    }
  } catch {
    return $null
  }
  return $null
}

function Get-LocalVersion {
  param([string]$Root)
  $pkgPath = Join-Path $Root 'package.json'
  if (Test-Path $pkgPath) {
    try {
      $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
      return [string]$pkg.version
    } catch {}
  }
  return '0.0.0'
}

function Compare-Semver {
  param([string]$Current, [string]$Remote)
  $c = ($Current -replace '^v', '').Split('-')[0].Split('.')
  $r = ($Remote -replace '^v', '').Split('-')[0].Split('.')
  $len = [Math]::Max($c.Length, $r.Length)
  for ($i = 0; $i -lt $len; $i++) {
    $cv = if ($i -lt $c.Length) { [int]($c[$i] -as [int]) } else { 0 }
    $rv = if ($i -lt $r.Length) { [int]($r[$i] -as [int]) } else { 0 }
    if ($rv -gt $cv) { return $true }
    if ($rv -lt $cv) { return $false }
  }
  return $false
}

function Ensure-PortableNode {
  param([string]$Root)

  # 1. Check bundled node_binary inside the app or parent folder
  $candidates = @(
    (Join-Path $Root 'node_binary\bin\node.exe'),
    (Join-Path $Root 'node_binary\node.exe'),
    (Join-Path $Root '..\node_binary\bin\node.exe'),
    (Join-Path $RuntimeCacheDir "$NodeZipName\node.exe")
  )
  foreach ($cand in $candidates) {
    if (Test-Path $cand) {
      $nodeDir = Split-Path -Parent (Resolve-Path $cand).Path
      $env:Path = "$nodeDir;$env:Path"
      return (Resolve-Path $cand).Path
    }
  }

  # 2. Check system node (>= 20.19)
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode) {
    try {
      $verRaw = & $sysNode.Source -v 2>$null
      if ($verRaw -match '^v(\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if (($major -eq 20 -and $minor -ge 19) -or ($major -ge 22)) {
          return $sysNode.Source
        }
      }
    } catch {}
  }

  # 3. Automatically download portable Node.js so the user needs nothing installed
  Write-Host "==============================================================" -ForegroundColor Cyan
  Write-Host " First-time setup: Downloading portable Node.js ($NodeVersion)..." -ForegroundColor Cyan
  Write-Host " No manual installation required. Please wait a moment..." -ForegroundColor Cyan
  Write-Host "==============================================================" -ForegroundColor Cyan

  New-Item -ItemType Directory -Force -Path $RuntimeCacheDir | Out-Null
  $zipPath = Join-Path $RuntimeCacheDir "$NodeZipName.zip"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $NodeDownloadUrl -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $RuntimeCacheDir -Force
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

  $downloadedNode = Join-Path $RuntimeCacheDir "$NodeZipName\node.exe"
  if (-not (Test-Path $downloadedNode)) {
    throw "Portable Node.js could not be extracted to $downloadedNode."
  }
  $nodeDir = Split-Path -Parent $downloadedNode
  $env:Path = "$nodeDir;$env:Path"
  return $downloadedNode
}

function Ensure-AppReady {
  param([string]$Root)
  Ensure-PortableNode -Root $Root | Out-Null

  Push-Location $Root
  try {
    $distIndex = Join-Path $Root 'dist\index.html'
    $wsModule = Join-Path $Root 'node_modules\ws\package.json'
    $sslModule = Join-Path $Root 'node_modules\@vitejs\plugin-basic-ssl\package.json'
    $viteModule = Join-Path $Root 'node_modules\vite\package.json'

    # If this is a pre-built Release package, dist/ and runtime node_modules are already ready!
    if ((Test-Path $distIndex) -and (Test-Path $wsModule) -and (Test-Path $sslModule) -and -not (Test-Path $viteModule)) {
      return
    }

    & node scripts\runtime-state.js dependencies-ready >$null 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Installing required packages (one-time setup)..." -ForegroundColor Yellow
      & npm.cmd ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    }

    & node scripts\runtime-state.js build-ready >$null 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Preparing Live Translate interface..." -ForegroundColor Yellow
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
    }
  } finally {
    Pop-Location
  }
}

function Check-RemoteUpdate {
  param([string]$Root)
  $localVer = Get-LocalVersion -Root $Root
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = "LiveTranslate/$localVer"; 'Accept' = 'application/vnd.github+json' }

  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$GitHubRepo/releases/latest" -Headers $headers -TimeoutSec 6 -ErrorAction Stop
    $remoteTag = [string]$release.tag_name
    if ($remoteTag -and (Compare-Semver -Current $localVer -Remote $remoteTag)) {
      $zipAsset = $null
      foreach ($asset in $release.assets) {
        if ($asset.name -match 'Windows.*\.zip$' -or $asset.name -match 'LiveTranslate.*\.zip$') {
          $zipAsset = $asset.browser_download_url
          break
        }
      }
      if (-not $zipAsset) { $zipAsset = $release.zipball_url }
      return @{
        Available = $true
        CurrentVersion = $localVer
        RemoteVersion = ($remoteTag -replace '^v', '')
        DownloadUrl = $zipAsset
      }
    }
    return @{ Available = $false; CurrentVersion = $localVer; RemoteVersion = ($remoteTag -replace '^v', '') }
  } catch {
    # Fallback to release or main branch package.json if no GitHub Release exists yet
    foreach ($branch in @('release', 'main')) {
      try {
        $pkg = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$GitHubRepo/$branch/package.json" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
        if ($pkg.version -and (Compare-Semver -Current $localVer -Remote ([string]$pkg.version))) {
          return @{
            Available = $true
            CurrentVersion = $localVer
            RemoteVersion = [string]$pkg.version
            DownloadUrl = "https://github.com/$GitHubRepo/archive/refs/heads/$branch.zip"
          }
        }
        return @{ Available = $false; CurrentVersion = $localVer; RemoteVersion = [string]$pkg.version }
      } catch {}
    }
  }
  return @{ Available = $false; CurrentVersion = $localVer; RemoteVersion = $localVer }
}

function Install-ZipUpdate {
  param(
    [string]$Root,
    [string]$DownloadUrl
  )
  Write-Host "Downloading Live Translate update..." -ForegroundColor Cyan
  $tempDir = Join-Path $env:TEMP "live-translate-update-$PID"
  $zipFile = Join-Path $tempDir 'update.zip'
  $extractDir = Join-Path $tempDir 'extracted'
  $backupDir = Join-Path $env:TEMP "live-translate-backup-$PID"

  New-Item -ItemType Directory -Force -Path $tempDir, $extractDir | Out-Null
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipFile -UseBasicParsing -Headers @{ 'User-Agent' = 'LiveTranslate-Updater' }
    Expand-Archive -Path $zipFile -DestinationPath $extractDir -Force

    # Find the inner root containing package.json
    $sourceRoot = $extractDir
    if (-not (Test-Path (Join-Path $sourceRoot 'package.json'))) {
      $sub = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
      if ($sub -and (Test-Path (Join-Path $sub.FullName 'package.json'))) {
        $sourceRoot = $sub.FullName
      } else {
        throw "Downloaded archive does not contain a valid Live Translate package."
      }
    }

    # Backup current directory before replacing files
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -Path (Join-Path $Root '*') -Destination $backupDir -Recurse -Force -ErrorAction SilentlyContinue

    try {
      Get-ChildItem -Path $sourceRoot -Force | ForEach-Object {
        $dest = Join-Path $Root $_.Name
        if (Test-Path $dest) {
          Remove-Item -Path $dest -Recurse -Force -ErrorAction Stop
        }
        Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force -ErrorAction Stop
      }
      Write-Host "Update installed successfully!" -ForegroundColor Green
    } catch {
      Write-Warning "Update interrupted; restoring previous version..."
      Get-ChildItem -Path $backupDir -Force | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $Root $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
      }
      throw
    }
  } finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Create-Shortcuts {
  param([string]$TargetRoot)
  $startBat = Join-Path $TargetRoot 'start-windows.bat'
  $wsh = New-Object -ComObject WScript.Shell

  $desktopPath = [Environment]::GetFolderPath('Desktop')
  $startMenuPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

  foreach ($folder in @($desktopPath, $startMenuPath)) {
    if ($folder -and (Test-Path $folder)) {
      $lnkPath = Join-Path $folder "$AppName.lnk"
      $shortcut = $wsh.CreateShortcut($lnkPath)
      $shortcut.TargetPath = $startBat
      $shortcut.WorkingDirectory = $TargetRoot
      $shortcut.Description = 'Start Live Translate Server and Operator Console'
      $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
      $shortcut.Save()
    }
  }
}

if ($Action -eq 'Install') {
  Write-Host "==============================================================" -ForegroundColor Cyan
  Write-Host " Installing Live Translate for Windows..." -ForegroundColor Cyan
  Write-Host "==============================================================" -ForegroundColor Cyan

  $targetRoot = $RepoRoot
  # If the user ran install-windows.bat from Downloads or a temporary folder and not a git repo, copy to %LOCALAPPDATA%\LiveTranslation-App
  $isGitRepo = Test-Path (Join-Path $RepoRoot '.git')
  if (-not $isGitRepo -and ($RepoRoot.TrimEnd('\') -ne $InstallDir.TrimEnd('\'))) {
    Write-Host "Copying application files to $InstallDir ..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Get-ChildItem -Path $RepoRoot -Force | ForEach-Object {
      $dest = Join-Path $InstallDir $_.Name
      if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
    }
    $targetRoot = $InstallDir
  }

  Ensure-AppReady -Root $targetRoot
  Create-Shortcuts -TargetRoot $targetRoot

  $choice = Show-Dialog -Title 'Live Translate Installed' -Message "Live Translate is installed and ready!`n`nA 'Live Translate' shortcut has been placed on your Windows Desktop and Start Menu.`n`nWould you like to launch Live Translate now?" -Buttons 'YesNo' -Icon 'Information'
  if ($choice -eq 'Yes' -or $choice -eq 'OK') {
    & $PSCommandPath -Action Start -RepoRoot $targetRoot
  }
  exit 0
}

if ($Action -eq 'Update') {
  $running = Get-RunningInstance
  if ($running -and $running.translationActive) {
    Show-Dialog -Title 'Live Translate Update' -Message 'A live translation session is currently active. Stop translation before installing an update.' -Buttons 'OK' -Icon 'Warning' | Out-Null
    exit 1
  }
  if ($running) {
    try { Invoke-RestMethod -Uri "$DashboardUrl/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch {}
    Start-Sleep -Seconds 1
  }

  $updateInfo = Check-RemoteUpdate -Root $RepoRoot
  if ($updateInfo.Available) {
    Install-ZipUpdate -Root $RepoRoot -DownloadUrl $updateInfo.DownloadUrl
    Ensure-AppReady -Root $RepoRoot
    Show-Dialog -Title 'Live Translate Updated' -Message "Live Translate has been updated to v$($updateInfo.RemoteVersion)!" -Buttons 'OK' -Icon 'Information' | Out-Null
  } else {
    Show-Dialog -Title 'Live Translate Update' -Message "Live Translate is already up to date (v$($updateInfo.CurrentVersion))." -Buttons 'OK' -Icon 'Information' | Out-Null
  }
  & $PSCommandPath -Action Start -RepoRoot $RepoRoot
  exit 0
}

# --- Action: Start ---
$running = Get-RunningInstance
if ($running) {
  $choice = Show-Dialog -Title 'Live Translate' -Message "Live Translate is already running.`n`nClick Yes to open the operator dashboard in your browser, or No to leave it running in the background." -Buttons 'YesNo' -Icon 'Information'
  if ($choice -eq 'Yes' -or $choice -eq 'OK') {
    Start-Process $DashboardUrl
  }
  exit 0
}

# Check for updates on cold start
$updateInfo = Check-RemoteUpdate -Root $RepoRoot
if ($updateInfo.Available) {
  $choice = Show-Dialog -Title 'Live Translate Update Available' -Message "A newer version of Live Translate (v$($updateInfo.RemoteVersion)) is available (you have v$($updateInfo.CurrentVersion)).`n`nWould you like to update now before starting? (Your saved API key and settings will be kept.)" -Buttons 'YesNo' -Icon 'Question'
  if ($choice -eq 'Yes') {
    try {
      Install-ZipUpdate -Root $RepoRoot -DownloadUrl $updateInfo.DownloadUrl
    } catch {
      Show-Dialog -Title 'Update Skipped' -Message "Could not complete the update automatically ($($_.Exception.Message)). Starting your current version instead." -Buttons 'OK' -Icon 'Warning' | Out-Null
    }
  }
}

Ensure-AppReady -Root $RepoRoot

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host " Starting Live Translate Server on $DashboardUrl" -ForegroundColor Green
Write-Host " Keep this window open while translation is running." -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green

# Open browser automatically once the server responds
Start-Job -ScriptBlock {
  param($Url)
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
      $req = [System.Net.WebRequest]::Create("$Url/api/instance")
      $req.Timeout = 1000
      $resp = $req.GetResponse()
      $resp.Close()
      Start-Process $Url
      return
    } catch {}
  }
  Start-Process $Url
} -ArgumentList $DashboardUrl | Out-Null

Push-Location $RepoRoot
try {
  & node server.js
} finally {
  Pop-Location
}
