param(
  [string]$Version = '',
  [string]$Dir = '',
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Name = 'slicc-audio'
$Repo = 'ai-ecoverse/slicc-audio'
$Commands = @('scsay', 'schear', 'scplay', 'scchime')
$MinNode = 24
$DataDir = Join-Path $env:LOCALAPPDATA 'slicc-audio'

function Fail([string]$Message, [int]$Code = 1) {
  [Console]::Error.WriteLine("${Name}: $Message")
  exit $Code
}

if ($args.Count -gt 0) { Fail "unknown option: $($args[0])" 2 }

if ($Help) {
  Write-Output 'Usage: install.ps1 [-Version VERSION] [-Dir DIR] [-Help]'
  Write-Output ''
  Write-Output "Install $Name ($($Commands -join ' ')), with Node $MinNode+ (downloaded if missing)."
  Write-Output ''
  Write-Output 'Options:'
  Write-Output '  -Version VERSION   install that release instead of the latest'
  Write-Output '  -Dir DIR           the launcher directory (default: %LOCALAPPDATA%\Programs\slicc-audio\bin)'
  Write-Output '  -Help              print this usage and exit'
  exit 0
}

if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\slicc-audio\bin' }
$Version = $Version -replace '^v', ''
$BaseUrl = $env:SLICC_INSTALL_BASE_URL
$NodeDist = if ($env:SLICC_NODE_DIST_BASE) { $env:SLICC_NODE_DIST_BASE.TrimEnd('/') } else { 'https://nodejs.org/dist' }

function Get-File([string]$Url, [string]$Out) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out
  } catch {
    Fail "cannot download ${Url}: $($_.Exception.Message)"
  }
}

function Get-Sum([string]$File, [string]$Entry) {
  foreach ($line in Get-Content -LiteralPath $File) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $Entry) { return $parts[0].ToLower() }
  }
  return $null
}

function Test-Sum([string]$File, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLower()
  if ($actual -ne $Expected) {
    [Console]::Error.WriteLine("${Name}: checksum mismatch for $(Split-Path -Leaf $File)")
    [Console]::Error.WriteLine("  expected: $Expected")
    [Console]::Error.WriteLine("  actual:   $actual")
    exit 1
  }
}

function Test-Node([string]$Node) {
  try {
    $v = & $Node --version 2>$null
    return ([int](($v -replace '^v', '').Split('.')[0])) -ge $MinNode
  } catch {
    return $false
  }
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("slicc-audio-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  $Node = $null
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found -and (Test-Node $found.Source)) { $Node = $found.Source }
  $managed = Join-Path $DataDir 'node\node.exe'
  if (-not $Node -and (Test-Path $managed) -and (Test-Node $managed)) { $Node = $managed }
  if (-not $Node) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    [Console]::Error.WriteLine("${Name}: no Node $MinNode+ found; downloading it")
    $index = Join-Path $Tmp 'index.json'
    Get-File "$NodeDist/index.json" $index
    $pick = Get-Content -Raw -LiteralPath $index | ConvertFrom-Json |
      Where-Object { $_.lts -and ([int](($_.version -replace '^v', '').Split('.')[0])) -ge $MinNode } |
      Select-Object -First 1
    if (-not $pick) { Fail "no Node $MinNode+ LTS release at $NodeDist" }
    $nodeVersion = $pick.version
    $archive = "node-$nodeVersion-win-$arch.zip"
    $sums = Join-Path $Tmp 'SHASUMS256.txt'
    Get-File "$NodeDist/$nodeVersion/SHASUMS256.txt" $sums
    $expected = Get-Sum $sums $archive
    if (-not $expected) { Fail "no checksum for $archive in SHASUMS256.txt" }
    $zip = Join-Path $Tmp $archive
    Get-File "$NodeDist/$nodeVersion/$archive" $zip
    Test-Sum $zip $expected
    $unpack = Join-Path $Tmp 'node'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
    $inner = Get-ChildItem -LiteralPath $unpack -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $nodeDest = Join-Path $DataDir 'node'
    if (Test-Path $nodeDest) { Remove-Item -Recurse -Force -LiteralPath $nodeDest }
    Move-Item -LiteralPath $inner.FullName -Destination $nodeDest
    [Console]::Error.WriteLine("${Name}: installed Node $nodeVersion to $nodeDest")
    $Node = $managed
  }
  $NodeDir = Split-Path -Parent $Node

  if (-not $BaseUrl) {
    $BaseUrl = if ($Version) { "https://github.com/$Repo/releases/download/v$Version" } else { "https://github.com/$Repo/releases/latest/download" }
  }
  $BaseUrl = $BaseUrl.TrimEnd('/')
  $sumsFile = Join-Path $Tmp 'SHA256SUMS'
  Get-File "$BaseUrl/SHA256SUMS" $sumsFile
  if ($Version) {
    $tgz = "slicc-audio-$Version.tgz"
  } else {
    $tgz = $null
    foreach ($line in Get-Content -LiteralPath $sumsFile) {
      $entry = ($line -split '\s+', 2)[1]
      if ($entry -and $entry.TrimStart('*') -match '^slicc-audio-[0-9][^/]*\.tgz$') { $tgz = $entry.TrimStart('*'); break }
    }
    if (-not $tgz) { Fail 'no slicc-audio-<version>.tgz in SHA256SUMS' }
  }
  $expected = Get-Sum $sumsFile $tgz
  if (-not $expected) { Fail "no checksum for $tgz in SHA256SUMS" }
  $tgzFile = Join-Path $Tmp $tgz
  Get-File "$BaseUrl/$tgz" $tgzFile
  Test-Sum $tgzFile $expected

  $pkgVersion = $tgz -replace '^slicc-audio-', '' -replace '\.tgz$', ''
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $stage = Join-Path $DataDir ".install-$PID"
  if (Test-Path $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  & tar.exe -xzf $tgzFile -C $stage --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail "cannot unpack $tgz" }

  $npm = Join-Path $NodeDir 'npm.cmd'
  if (-not (Test-Path $npm)) {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $cmd) { Fail "npm not found next to $Node" }
    $npm = $cmd.Source
  }
  $env:Path = "$NodeDir;$env:Path"
  Push-Location $stage
  try {
    $log = & $npm install --omit=dev --ignore-scripts --no-audit --no-fund 2>&1
    $npmCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmCode -ne 0) {
    [Console]::Error.WriteLine(($log | Out-String))
    Remove-Item -Recurse -Force -LiteralPath $stage
    Fail 'npm install failed'
  }

  $target = Join-Path $DataDir $pkgVersion
  if (Test-Path $target) { Remove-Item -Recurse -Force -LiteralPath $target }
  Move-Item -LiteralPath $stage -Destination $target
  $current = Join-Path $DataDir 'current'
  if (Test-Path $current) { (Get-Item -LiteralPath $current).Delete() }
  New-Item -ItemType Junction -Path $current -Target $target | Out-Null

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $Dir = (Resolve-Path -LiteralPath $Dir).Path
  foreach ($cmd in $Commands) {
    $entry = Join-Path $current "host\$cmd.mjs"
    $launcher = "@echo off`r`n`"$Node`" `"$entry`" %*`r`n"
    [System.IO.File]::WriteAllText((Join-Path $Dir "$cmd.cmd"), $launcher, (New-Object System.Text.ASCIIEncoding))
  }

  $info = @{ version = $pkgVersion; dir = $Dir } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $DataDir 'install.json'), $info + "`n", (New-Object System.Text.UTF8Encoding $false))

  foreach ($old in Get-ChildItem -LiteralPath $DataDir -Directory) {
    if ($old.Name -match '^[0-9]' -and $old.Name -ne $pkgVersion) { Remove-Item -Recurse -Force -LiteralPath $old.FullName }
  }

  $installed = ''
  foreach ($cmd in $Commands) {
    $out = & (Join-Path $Dir "$cmd.cmd") --version
    if ($LASTEXITCODE -ne 0) { Fail "$cmd --version failed" }
    $installed = ($out | Select-Object -First 1) -replace "^$cmd ", ''
  }
  Write-Output "$Name $installed installed to $Dir"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = if ($userPath) { $userPath.Split(';') } else { @() }
  if ($parts -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) | Where-Object { $_ }) -join ';', 'User')
    Write-Output "Added $Dir to your user PATH; open a new terminal to use it."
  }
} finally {
  Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue
}
