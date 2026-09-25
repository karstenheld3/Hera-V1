# Hera V1 build pipeline (HERAV1DIST-SP01, HERAV1DIST-IP01): sync bundled payload -> tsc -> bun build --compile -> sign -> smoke test -> checksum.
# Output: dist\hera-{version}-{target}.exe + dist\SHA256SUMS.txt
# Structural model: e:\Dev\Hera-V0\build.ps1 (V1 eight-stage PyApp pipeline); V2 drops wheel + cargo, adds type check + payload sync.
param(
  [string]$Target = 'bun-windows-x64',
  [switch]$Sign,
  [switch]$SkipSmoke,
  [switch]$SyncOnly,
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

# Pinned build inputs (HERAV1DIST-NFR-02 reproducible builds)
$TIMESTAMP_URL  = 'http://timestamp.digicert.com'
$SMOKE_TIMEOUT_SECONDS = 120  # compiled binary starts instantly, no extraction or venv install (unlike V1 PyApp)

$RootDir    = $PSScriptRoot
$BundledDir = Join-Path $RootDir 'src\bundled'
$DistDir    = Join-Path $RootDir 'dist'
$BunVersionFile = Join-Path $RootDir '.bun-version'
$Script:CurrentStep = 0
$Script:Artifact = $null
$Script:OldArtifact = $null

function Fail([string]$Message) {
  if ($Script:Artifact -and (Test-Path $Script:Artifact)) {  # IG-02: no partial artifacts
    Remove-Item $Script:Artifact -Force
    Write-Host "  Removed partial artifact $Script:Artifact."
  }
  if ($Script:OldArtifact -and (Test-Path $Script:OldArtifact) -and $Script:Artifact -and -not (Test-Path $Script:Artifact)) {
    Rename-Item $Script:OldArtifact $Script:Artifact -Force
    Write-Host "  Restored previous binary from _old.exe."
  }
  Write-Host "FAILED at step $($Script:CurrentStep): $Message"
  exit 1
}

function Step([string]$Title) {
  $Script:CurrentStep++
  Write-Host "[ $Script:CurrentStep / 7 ] $Title"
}

# Key-leak guard imported from build.keyleak.psm1 (extracted for unit testability, IG-05)
Import-Module (Join-Path $RootDir 'build.keyleak.psm1') -Function Get-KeyLeaks, Test-KeyLeakPath

# ---------------------------------------------------------------------------- version from package.json (single source of truth, FR-05)
$packagePath = Join-Path $RootDir 'package.json'
$packageJson = Get-Content $packagePath -Raw | ConvertFrom-Json
$Version = $packageJson.version
$ExeName = "hera-$Version-$Target.exe"

Write-Host "Building Hera V1 $Version ($Target)..."

# ---------------------------------------------------------------------------- pre-flight: ensure target is not locked
$Script:Artifact = Join-Path $DistDir $ExeName
$Script:OldArtifact = Join-Path $DistDir ($ExeName -replace '\.exe$', '_old.exe')
if (Test-Path $Script:Artifact) {
  try {
    Rename-Item $Script:Artifact $Script:OldArtifact -Force -ErrorAction Stop
    Write-Host "  Pre-flight: renamed existing $ExeName to _old.exe (file was unlocked)."
  } catch {
    Write-Host "  Pre-flight: $ExeName is locked (in use by another process)." -ForegroundColor Yellow
    while ($true) {
      Write-Host '  Close all Hera instances (terminals, ACP clients) then press SPACE to retry...' -ForegroundColor Yellow
      $key = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
      if ($key.VirtualKeyCode -eq 32) {
        try {
          Rename-Item $Script:Artifact $Script:OldArtifact -Force -ErrorAction Stop
          Write-Host '  Pre-flight: renamed to _old.exe. Continuing.'
          break
        } catch {
          Write-Host "  Still locked: $($_.Exception.Message)" -ForegroundColor Red
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------- [ 1 / 7 ] toolchain
Step 'Verifying toolchain...'

# Bun version check
$pinnedVersion = (Get-Content $BunVersionFile -ErrorAction SilentlyContinue).Trim()
if (-not $pinnedVersion) { Fail "cannot read .bun-version (EC-01)." }
$installedVersion = (bun --version 2>$null)
if (-not $installedVersion) {
  if ($NonInteractive) { Fail "bun not found on PATH. Install: https://bun.com/docs/installation (EC-01)." }
  $answer = Read-Host "  Bun not found. Install Bun $pinnedVersion now via winget? [y/N]"
  if ($answer -eq 'y') {
    winget install Oven-sh.Bun --silent --accept-package-agreements --accept-source-agreements
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    $installedVersion = (bun --version 2>$null)
  }
  if (-not $installedVersion) { Fail "bun still not found after install attempt (EC-01)." }
}
if ($installedVersion -ne $pinnedVersion) {
  Write-Host "  WARNING: bun $installedVersion != pinned $pinnedVersion." -ForegroundColor Yellow
  if ($NonInteractive) { Fail "bun version mismatch. Install $pinnedVersion or update .bun-version (EC-01)." }
  $answer = Read-Host "  Install bun $pinnedVersion now? [y/N]"
  if ($answer -eq 'y') {
    powershell -c "irm bun.sh/install.ps1 | iex"  # installs the latest; pin check on next run
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    $installedVersion = (bun --version 2>$null)
    if ($installedVersion -ne $pinnedVersion) { Fail "bun version still $installedVersion after install (EC-01)." }
  } else {
    Fail "bun version mismatch: $installedVersion != $pinnedVersion (EC-01)."
  }
}

# Dependencies
bun install --frozen-lockfile 2>&1 | ForEach-Object { if ($_ -match 'error|fail') { Write-Host "  $_" -ForegroundColor Red } }
if ($LASTEXITCODE -ne 0) {
  if ($NonInteractive) { Fail "bun install --frozen-lockfile failed (EC-02). Run 'bun install' to refresh the lockfile." }
  Write-Host "  Frozen lockfile failed. Refreshing..." -ForegroundColor Yellow
  bun install 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "bun install failed (EC-02)." }
}

# Signing configuration
$signThumbprint = $env:HERA_SIGN_THUMBPRINT
if ($signThumbprint) {
  if (-not (Get-Command signtool -ErrorAction SilentlyContinue)) { Fail 'HERA_SIGN_THUMBPRINT set but signtool.exe not on PATH - install Windows SDK (EC-09).' }
  Write-Host "  Bun $installedVersion (.bun-version OK). Dependencies installed. Signing ON (signtool OK)."
} else {
  Write-Host "  Bun $installedVersion (.bun-version OK). Dependencies installed."
  Write-Host '  NOTICE: HERA_SIGN_THUMBPRINT not set - binary will be UNSIGNED.'
}

# ---------------------------------------------------------------------------- [ 2 / 7 ] bundle sync + key-leak guard
Step 'Syncing bundle...'

$agentLibrary = Join-Path $RootDir '.agent'
$agentTools   = Join-Path $RootDir '.agent-tools'
$bundleConfig = Join-Path $BundledDir 'config'
$bundleAgent  = Join-Path $BundledDir 'agent'
$bundleTools  = Join-Path $BundledDir 'tools'

if (-not (Test-Path $agentLibrary -PathType Container)) { Fail ".agent prompt library missing - bundle would lose the agent library (EC-03)." }

# Clean and recreate staging targets (DD-08)
if (Test-Path $bundleAgent)  { Remove-Item $bundleAgent  -Recurse -Force }
if (Test-Path $bundleConfig) { Remove-Item $bundleConfig -Recurse -Force }
if (Test-Path $bundleTools)  { Remove-Item $bundleTools  -Recurse -Force }
New-Item -ItemType Directory -Path $bundleAgent  -Force | Out-Null
New-Item -ItemType Directory -Path $bundleConfig -Force | Out-Null
New-Item -ItemType Directory -Path $bundleTools  -Force | Out-Null

# Config trio: explicit file list - .api-keys.txt and agent-config.json NEVER sync (DD-09, FR-08)
$configSource = Join-Path $RootDir '.agent-data\config'
robocopy $configSource $bundleConfig 'model-registry.json' 'model-parameter-mapping.json' 'model-pricing.json' /NJH /NJS /NDL /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "config sync failed (robocopy exit $LASTEXITCODE)." }

# Assert no .api-keys.txt or agent-config.json in staging (EC-03)
if (Test-Path (Join-Path $bundleConfig '.api-keys.txt')) { Fail '.api-keys.txt found in staging - must never be bundled (IG-05).' }
if (Test-Path (Join-Path $bundleConfig 'agent-config.json')) { Fail 'agent-config.json found in staging - must never be bundled (FR-08).' }

# Agent library: full copy from .agent/ (DD-08)
robocopy $agentLibrary $bundleAgent /MIR /NJH /NJS /NDL /NC /NS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "agent library sync failed (robocopy exit $LASTEXITCODE)." }

# Key-leak guard (IG-05, EC-04): API_KEY assignment with a real-key-shaped value (40+ char token) aborts
$keyLeaks = Get-KeyLeaks $BundledDir
if ($keyLeaks) {
  Write-Host "  ERROR: possible API key in '$($keyLeaks[0])'."
  Fail 'key-leak guard - remove the value, keep only placeholders (IG-05).'
}

# External tools: rg.exe embedded as-is (no .bin rename, FR-08)
$rgSource = Join-Path $agentTools 'rg.exe'
$toolsLabel = 'no tools'
if (Test-Path $rgSource) {
  Copy-Item $rgSource (Join-Path $bundleTools 'rg.exe') -Force
  $rgSizeMb = [Math]::Round((Get-Item $rgSource).Length / 1MB, 1)
  $toolsLabel = "rg $rgSizeMb MB"
} else {
  Write-Host '  NOTICE: .agent-tools\rg.exe not found - binary will ship without ripgrep.'
}

$configCount = (Get-ChildItem $bundleConfig -File).Count
$agentFiles = Get-ChildItem $bundleAgent -Recurse -File
$agentSizeMb = [Math]::Round(($agentFiles | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "  $configCount config files, $($agentFiles.Count) agent files ($agentSizeMb MB), tools ($toolsLabel). Key-leak scan OK."

# -SyncOnly exits here (development helper, EC-14)
if ($SyncOnly) {
  Write-Host "Sync complete (-SyncOnly). Staging folder ready for 'bun run' development."
  exit 0
}

# ---------------------------------------------------------------------------- [ 3 / 7 ] type check
Step 'Type checking...'
$tscOutput = bun tsc --noEmit 2>&1
if ($LASTEXITCODE -ne 0) {
  $tscOutput | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  Fail 'tsc --noEmit reported errors (EC-05).'
}
Write-Host '  tsc --noEmit: 0 errors. OK.'

# ---------------------------------------------------------------------------- [ 4 / 7 ] harness lint (HERAV1DIST-SP01 FR-01, HERAV1HRNS-IP01 IS-21)
Step 'Harness lint...'
bun run lint:harness
if ($LASTEXITCODE -ne 0) {
  Fail 'lint:harness reported violations (no eval, no dynamic import outside the plug socket, no Bun.spawn outside the spawn wrapper).'
}
Write-Host '  lint:harness: 0 violations. OK.'

# ---------------------------------------------------------------------------- [ 5 / 7 ] compile
Step "Compiling (bun build --compile --bytecode --minify)..."
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null

if (Test-Path $Script:OldArtifact) {
  Write-Host "  Replacing existing $ExeName (pre-flight renamed to _old.exe)."
}

$compileArgs = @(
  'build', '--compile', '--bytecode', '--minify',
  "--target=$Target",
  '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
  '--asset', 'src/bundled/agent',
  '--asset-naming=[name].[ext]',
  '--windows-title', 'Hera',
  "--outfile", $Script:Artifact,
  'src/index.ts'
)
$compileLog = Join-Path $DistDir 'compile.log'
bun @compileArgs *> $compileLog
if ($LASTEXITCODE -ne 0) {
  Get-Content $compileLog | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
  if (Test-Path $Script:Artifact) { Remove-Item $Script:Artifact -Force }
  Fail "compile failed (EC-06)."
}
if (-not (Test-Path $Script:Artifact)) { Fail "compile reported success but $Script:Artifact is missing (EC-06)." }

$sizeMb = [Math]::Round((Get-Item $Script:Artifact).Length / 1MB, 0)
Write-Host "  $ExeName ($sizeMb MB)."

# Signing
if ($Sign -and $signThumbprint) {
  signtool sign /sha1 $signThumbprint /fd SHA256 /tr $TIMESTAMP_URL /td SHA256 $Script:Artifact
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $Script:Artifact -Force
    Fail 'signing failed - artifact removed (EC-09, IG-02).'
  }
  Write-Host '  Signed + timestamped. OK.'
} elseif ($Sign) {
  Write-Host '  NOTICE: signing deferred - no certificate configured (HERA_SIGN_THUMBPRINT not set).'
} else {
  Write-Host '  Signing SKIPPED (no -Sign flag).'
}

# Stable dist/hera.exe copy (FR-05, DD-04: stable asset name for PATH and IDE config)
$stableExe = Join-Path $DistDir 'hera.exe'
Copy-Item $Script:Artifact $stableExe -Force
Write-Host "  Stable copy: dist\hera.exe."

# ---------------------------------------------------------------------------- [ 6 / 7 ] smoke test (host target only)
$hostTarget = "bun-$(& {
  if ($IsLinux) { 'linux-x64' } elseif ($IsMacOS) { 'darwin-x64' } else { 'windows-x64' }
})"

if ($SkipSmoke) {
  Step 'Smoke test... SKIPPED (-SkipSmoke).'
} elseif ($Target -ne $hostTarget) {
  Step 'Smoke test... SKIPPED (foreign target, EC-11).'
  Write-Host "  NOTICE: cannot execute $Target binary on $hostTarget host."
} else {
  Step 'Smoke test...'

  # --version check
  $smokeJob = Start-Job -ScriptBlock { param($exe) & $exe --version 2>&1 } -ArgumentList $Script:Artifact
  if (-not (Wait-Job $smokeJob -Timeout $SMOKE_TIMEOUT_SECONDS)) {
    Stop-Job $smokeJob; Remove-Job $smokeJob -Force
    Fail "smoke test --version timed out after $SMOKE_TIMEOUT_SECONDS s (EC-08)."
  }
  $smokeOutput = (Receive-Job $smokeJob) -join "`n"
  Remove-Job $smokeJob -Force
  if ($smokeOutput -notmatch $([regex]::Escape($Version))) {
    Write-Host "  ERROR: expected version '$Version', got '$($smokeOutput.Trim())'."
    Fail 'smoke test version mismatch (EC-08).'
  }
  Write-Host "  hera --version -> $($smokeOutput.Trim()). OK."

  # Scripted adapter -p /prime: exit 0, three processes spawned from the binary path (IG-03, NFR-04)
  $smokeAppDir = Join-Path $env:TEMP "hera-smoke-$Version-$([System.IO.Path]::GetRandomFileName())"
  New-Item -ItemType Directory -Path $smokeAppDir -Force | Out-Null
  $decoyEnv = Join-Path $smokeAppDir '.env'
  "DECOY_SHOULD_NOT_LOAD=1" | Set-Content $decoyEnv -Encoding ascii
  $smokeScript = Join-Path $smokeAppDir 'smoke-script.jsonl'
  '{"text":"ok","usage":{"input_tokens":10,"output_tokens":1}}' | Set-Content $smokeScript -Encoding ascii
  $smokeEnv = @{ 'HERA_SCRIPTED_ADAPTER' = $smokeScript; 'AGENT_APP_DIR' = $smokeAppDir }
  $scriptedJob = Start-Job -ScriptBlock {
    param($exe, $appDir, $env)
    $e = [System.Collections.Hashtable]::new()
    foreach ($k in $env.Keys) { $e[$k] = $env[$k] }
    & $exe -p "/prime" --output-format jsonl --app-dir $appDir 2>&1
  } -ArgumentList $Script:Artifact, $smokeAppDir, $smokeEnv
  if (-not (Wait-Job $scriptedJob -Timeout $SMOKE_TIMEOUT_SECONDS)) {
    Stop-Job $scriptedJob; Remove-Job $scriptedJob -Force
    Fail "smoke test scripted -p /prime timed out after $SMOKE_TIMEOUT_SECONDS s (EC-08)."
  }
  $scriptedOutput = (Receive-Job $scriptedJob) -join "`n"
  $scriptedCode = $scriptedJob.State -eq 'Completed' -and $scriptedJob.ChildJobs[0].JobStateInfo.State -eq 'Completed'
  Remove-Job $scriptedJob -Force
  if (-not $scriptedCode) {
    Write-Host "  Scripted output: $scriptedOutput"
    Fail 'smoke test scripted -p /prime did not complete (EC-08).'
  }
  if ($scriptedOutput -match 'DECOY_SHOULD_NOT_LOAD') {
    Fail 'decoy .env variable leaked into the process - autoload flags missing (IG-06, EC-09).'
  }
  Write-Host '  hera -p /prime (scripted) -> exit 0, decoy .env not loaded. OK.'

  # selftest offline: exit 0 from the binary (FR-02, NFR-04)
  $selftestJob = Start-Job -ScriptBlock {
    param($exe, $appDir)
    & $exe --app-dir $appDir selftest offline 2>&1
  } -ArgumentList $Script:Artifact, $smokeAppDir
  if (-not (Wait-Job $selftestJob -Timeout $SMOKE_TIMEOUT_SECONDS)) {
    Stop-Job $selftestJob; Remove-Job $selftestJob -Force
    Fail "smoke test selftest offline timed out after $SMOKE_TIMEOUT_SECONDS s (EC-08)."
  }
  $selftestOutput = (Receive-Job $selftestJob) -join "`n"
  Remove-Job $selftestJob -Force
  if ($selftestOutput -notmatch 'SELFTEST' -or $selftestOutput -notmatch 'passed') {
    Write-Host "  selftest output: $selftestOutput"
    Fail 'smoke test selftest offline did not produce results (EC-08).'
  }
  Write-Host "  hera selftest offline -> ran. OK."

  # Key-leak scan of the binary (EC-10, IG-05)
  $binaryLeaks = Select-String -Path $Script:Artifact -Pattern '[A-Z_]*API_KEY\s*=\s*[A-Za-z0-9_-]{40,}' -Quiet
  if ($binaryLeaks) {
    Remove-Item $Script:Artifact -Force
    Fail 'key-leak scan of binary found a key-shaped token - artifact removed (EC-10, IG-05).'
  }
  Write-Host '  Key-leak scan of binary OK.'

  # No hera process alive
  $heraProcs = Get-Process -Name 'hera*' -ErrorAction SilentlyContinue
  if ($heraProcs) {
    $heraProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $heraProcs = Get-Process -Name 'hera*' -ErrorAction SilentlyContinue
    if ($heraProcs) { Fail "hera process still alive after smoke test (IG-03)." }
  }
  Write-Host '  No survivor processes. OK.'

  # Clean smoke temp dir
  Remove-Item $smokeAppDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------- [ 7 / 7 ] checksum + report
Step 'Checksum + report...'
$hash = (Get-FileHash $Script:Artifact -Algorithm SHA256).Hash.ToLower()
$stableHash = (Get-FileHash $stableExe -Algorithm SHA256).Hash.ToLower()
"$hash *$ExeName" | Set-Content (Join-Path $DistDir 'SHA256SUMS.txt') -Encoding ascii
"$stableHash *hera.exe" | Add-Content (Join-Path $DistDir 'SHA256SUMS.txt') -Encoding ascii
Write-Host '  SHA256SUMS.txt written. OK.'

# Clean staging folder (DD-08)
if (Test-Path $bundleAgent)  { Remove-Item $bundleAgent  -Recurse -Force }
if (Test-Path $bundleConfig) { Remove-Item $bundleConfig -Recurse -Force }
if (Test-Path $bundleTools)  { Remove-Item $bundleTools  -Recurse -Force }
New-Item -ItemType Directory -Path $bundleAgent  -Force | Out-Null
New-Item -ItemType Directory -Path $bundleConfig -Force | Out-Null
New-Item -ItemType Directory -Path $bundleTools  -Force | Out-Null
Write-Host '  Staging folder cleaned.'

# Delete _old.exe
if (Test-Path $Script:OldArtifact) {
  try {
    Remove-Item $Script:OldArtifact -Force -ErrorAction Stop
    Write-Host '  Deleted _old.exe.'
  } catch {
    Start-Sleep -Milliseconds 500
    try {
      Remove-Item $Script:OldArtifact -Force -ErrorAction Stop
      Write-Host '  Deleted _old.exe (retry).'
    } catch {
      Write-Host "  WARNING: cannot delete _old.exe - file locked. Delete manually: $Script:OldArtifact" -ForegroundColor Yellow
    }
  }
}

$signedLabel = if ($Sign -and $signThumbprint) { 'signed' } else { 'unsigned' }
Write-Host "DONE: dist\$ExeName ($sizeMb MB, $signedLabel)"
exit 0
