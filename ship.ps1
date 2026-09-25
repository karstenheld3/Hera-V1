# Hera V1 version bump: analyze commits since last tag, determine semver bump, update package.json, commit.
# Run AFTER build.bat succeeds and before /project-release.
$ErrorActionPreference = 'Stop'

$RootDir = $PSScriptRoot
$PackagePath = Join-Path $RootDir 'package.json'

# ---- read current version from package.json
$package = Get-Content $PackagePath -Raw | ConvertFrom-Json
$currentVersion = $package.version
$parts = $currentVersion -split '\.'
if ($parts.Count -ne 3) { Write-Host "ERROR: version '$currentVersion' is not semver (X.Y.Z)."; exit 1 }
$major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
Write-Host "Current version: $currentVersion"

# ---- find last tag
$lastTag = git tag --sort=-creatordate 2>$null | Select-Object -First 1
$range = if ($lastTag) { "$lastTag..HEAD" } else { 'HEAD' }
if ($lastTag) { Write-Host "Last tag: $lastTag" } else { Write-Host 'No previous tag found - analyzing all commits.' }

# ---- analyze commits since last tag
$commits = git log $range --oneline --no-merges 2>$null
if (-not $commits) { Write-Host 'No new commits since last tag. Nothing to bump.'; exit 0 }
Write-Host "$($commits.Count) commits since last tag:"
$commits | ForEach-Object { Write-Host "  $_" }

$hasBreaking = $false
$hasFeat = $false
$hasFix = $false
foreach ($line in $commits) {
  if ($line -match '!:' -or $line -match 'BREAKING') { $hasBreaking = $true }
  elseif ($line -match '^[0-9a-f]+\s+feat') { $hasFeat = $true }
  elseif ($line -match '^[0-9a-f]+\s+fix') { $hasFix = $true }
}

# ---- determine bump
if ($hasBreaking) {
  $major++; $minor = 0; $patch = 0
  $bumpType = 'MAJOR (breaking change)'
} elseif ($hasFeat) {
  $minor++; $patch = 0
  $bumpType = 'MINOR (new feature)'
} else {
  $patch++
  $bumpType = 'PATCH (fixes/docs/chore)'
}
$newVersion = "$major.$minor.$patch"
Write-Host ""
Write-Host "Bump: $bumpType"
Write-Host "  $currentVersion -> $newVersion"

# ---- confirm
$answer = Read-Host "Apply version bump to $newVersion? [y/N]"
if ($answer -ne 'y') { Write-Host 'Aborted.'; exit 0 }

# ---- update package.json
$package.version = $newVersion
$package | ConvertTo-Json -Depth 10 | Set-Content -Path $PackagePath -Encoding utf8
Write-Host "Updated package.json: version = `"$newVersion`""

# ---- commit
git add $PackagePath 2>$null
git commit -q -m "chore: bump version to $newVersion"
Write-Host "Committed: chore: bump version to $newVersion"
Write-Host ""
Write-Host "Next: run /project-release to create release notes, tag, and GitHub release."
