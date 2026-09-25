<#
.SYNOPSIS
  reindent.ps1 - Convert PowerShell file indentation to target spaces.

.DESCRIPTION
  Auto-detects source indentation and skips files already at target.
  Excludes itself from processing.

.EXAMPLE
  pwsh reindent.ps1 file.ps1 --to 2
  pwsh reindent.ps1 folder/ --to 2 --recursive
  pwsh reindent.ps1 folder/ --to 2 --recursive --dry-run
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path,
  [int]$To = 2,
  [switch]$Recursive,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Get-Indentation([string]$Content) {
  foreach ($line in $Content -split "`n") {
    $stripped = $line.TrimStart(' ')
    if ($stripped -and -not $stripped.StartsWith('#')) {
      $leading = $line.Length - $stripped.Length
      if ($leading -gt 0) {
        if ($leading -le 2) { return 2 }
        return 4
      }
    }
  }
  return 4
}

function Convert-Indentation([string]$Content, [int]$FromSpaces, [int]$ToSpaces) {
  if ($FromSpaces -eq $ToSpaces) { return $Content }
  $lines = $Content -split "`n"
  $result = @()
  foreach ($line in $lines) {
    if (-not $line -or [string]::IsNullOrWhiteSpace($line)) {
      $result += $line
      continue
    }
    $stripped = $line.TrimStart(' ')
    $leadingSpaces = $line.Length - $stripped.Length
    if ($leadingSpaces -eq 0) {
      $result += $line
      continue
    }
    $indentLevels = [Math]::Floor($leadingSpaces / $FromSpaces)
    $remainder = $leadingSpaces % $FromSpaces
    $newIndent = ' ' * ($indentLevels * $ToSpaces + $remainder)
    $result += $newIndent + $stripped
  }
  return $result -join "`n"
}

function Process-File([string]$FilePath, [int]$ToSpaces, [bool]$DryRun) {
  try {
    $content = [System.IO.File]::ReadAllText($FilePath, [System.Text.UTF8Encoding]::new($false))
  } catch {
    return $false, "ERROR reading -> $_"
  }
  $actualFrom = Get-Indentation $content
  if ($actualFrom -eq $ToSpaces) { return $false, "already $ToSpaces-space" }
  $newContent = Convert-Indentation $content $actualFrom $ToSpaces
  if ($content -eq $newContent) { return $false, "unchanged" }
  if ($DryRun) { return $true, "would change" }
  try {
    [System.IO.File]::WriteAllText($FilePath, $newContent, [System.Text.UTF8Encoding]::new($false))
    return $true, "changed"
  } catch {
    return $false, "ERROR writing -> $_"
  }
}

# ── Main ──────────────────────────────────────────────────────────
$resolvedPath = (Resolve-Path $Path -ErrorAction Stop).Path

$files = @()
if (Test-Path $resolvedPath -PathType Leaf) {
  $files = @($resolvedPath)
} elseif (Test-Path $resolvedPath -PathType Container) {
  $pattern = if ($Recursive) { '*.ps1' } else { '*.ps1' }
  $files = @(Get-ChildItem $resolvedPath -Filter $pattern -File)
  if ($Recursive) {
    $files = @(Get-ChildItem $resolvedPath -Filter '*.ps1' -File -Recurse)
  }
}

# Exclude this script from processing
$thisScript = (Resolve-Path $MyInvocation.MyCommand.Path).Path
$files = @($files | Where-Object { $_ -ne $thisScript })

if ($files.Count -eq 0) {
  [Console]::Error.WriteLine('No PowerShell files found.')
  exit 0
}

$fileWord = if ($files.Count -eq 1) { "file" } else { "files" }
[Console]::Error.WriteLine("Processing $($files.Count) $fileWord -> $To-space indentation")
if ($DryRun) { [Console]::Error.WriteLine('(dry-run mode)') }

$changedCount = 0
foreach ($f in $files) {
  $changed, $msg = Process-File $f $To $DryRun
  if ($changed) { $changedCount++ }
  Write-Host "  ${msg}: $f"
}

$fileWord = if ($changedCount -eq 1) { "file" } else { "files" }
$action = if ($DryRun) { "would be changed" } else { "changed" }
[Console]::Error.WriteLine("Total: $changedCount/$($files.Count) $fileWord $action")
