<#
.SYNOPSIS
    Generic PromptSystem sync script with -diff and -execute modes.
.DESCRIPTION
    Reads all sync configuration from promptsystem-sync.json (-config parameter).
    Uses targets array with per-target include/exclude/never_overwrite.
    Top-level deprecated array shared across all targets.
    Source repo is purely a content provider (read-only during sync).
.PARAMETER diff
    Preview mode: show changes, modify nothing.
.PARAMETER execute
    Apply mode: copy, delete, update last_sync timestamp.
.PARAMETER config
    Path to promptsystem-sync.json file (required).
.PARAMETER output_file
    File path for full diff report. Default: console.
.PARAMETER preview_file
    File path for markdown preview (PROMPTSYSTEM_SYNC_PREVIEW_TEMPLATE.md format).
    Use with -diff: produces per-target blocks for chat presentation.
.PARAMETER showVerbose
    Show excluded files and skip reasons in output.
.EXAMPLE
    sync.ps1 -diff -config "promptsystem-sync.json" -preview_file ".tmp_sync_preview.md"
.EXAMPLE
    sync.ps1 -execute -config "promptsystem-sync.json"
#>

[CmdletBinding()]
param(
    [switch]$diff,
    [switch]$execute,
    [string]$config,
    [string]$output_file,
    [string]$preview_file,
    [switch]$showVerbose,
    [switch]$reverse
)

# ============================================================
# Functions
# ============================================================

function Test-SyncConfig {
    param([object]$Config, [string]$ConfigPath)
    $errors = @()
    if (-not $Config.targets) {
        $errors += "Missing 'targets' array in '$ConfigPath'."
    }
    if ($Config.targets -and $Config.targets -isnot [array]) {
        $errors += "'targets' must be an array in '$ConfigPath'."
    }
    if ($Config.deprecated -and $Config.deprecated -isnot [array]) {
        $errors += "Top-level 'deprecated' must be an array in '$ConfigPath'."
    }
    foreach ($tgt in $Config.targets) {
        if ($null -eq $tgt) {
            $errors += "Target entry is null in '$ConfigPath'."
            continue
        }
        if (-not $tgt.path) { $errors += "Target entry missing 'path' field in '$ConfigPath'." }
        if (-not $tgt.source) { $errors += "Target '$($tgt.path)' missing 'source' field." }
        if (-not $tgt.include) { $errors += "Target '$($tgt.path)' missing 'include' array." }
        foreach ($field in @('include', 'exclude', 'never_overwrite')) {
            $val = $tgt.$field
            if ($null -ne $val -and $val -isnot [array]) {
                $errors += "Target '$($tgt.path)' field '$field' must be an array, got $($val.GetType().Name)."
            }
        }
    }
    if ($errors.Count -gt 0) {
        foreach ($e in $errors) { Write-Error $e }
        exit 2
    }
}

function Test-GlobMatch {
    param([string]$Path, [string[]]$Patterns)
    if (-not $Patterns -or $Patterns.Count -eq 0) { return $false }
    $options = if ($IsLinux -or $IsMacOS) {
        [System.Management.Automation.WildcardOptions]::None
    } else {
        [System.Management.Automation.WildcardOptions]::IgnoreCase
    }
    foreach ($pattern in $Patterns) {
        $wildcard = [System.Management.Automation.WildcardPattern]::new(
            $pattern,
            $options
        )
        if ($wildcard.IsMatch($Path)) { return $true }
    }
    return $false
}

function Get-FileHash256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-RelativePath {
    param([string]$BasePath, [string]$FullPath)
    $baseFull = [System.IO.Path]::GetFullPath($BasePath)
    if (-not $baseFull.EndsWith('\') -and -not $baseFull.EndsWith('/')) {
        $baseFull += '\'
    }
    $fullFull = $FullPath
    if ($fullFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        $rel = $fullFull.Substring($baseFull.Length)
    } else {
        $rel = [System.IO.Path]::GetFileName($FullPath)
    }
    return $rel
}

function Get-SourceFiles {
    param([string]$SourceRoot)
    $files = @()
    $sourceRootFull = [System.IO.Path]::GetFullPath($SourceRoot)
    $enumerated = [System.IO.Directory]::EnumerateFiles(
        $sourceRootFull,
        '*',
        [System.IO.SearchOption]::AllDirectories
    )
    foreach ($fullPath in $enumerated) {
        $relativePath = Get-RelativePath -BasePath $sourceRootFull -FullPath $fullPath
        $relativePath = $relativePath -replace '\\', '/'
        $files += [PSCustomObject]@{
            FullPath     = $fullPath
            RelativePath = $relativePath
        }
    }
    return $files
}

function Invoke-FileFilter {
    param(
        [object]$TargetEntry,
        [array]$Files
    )
    $result = @{
        Included = @()
        Excluded = @()
    }

    $includePatterns = @($TargetEntry.include)
    $excludePatterns = @($TargetEntry.exclude)
    if (-not $excludePatterns) { $excludePatterns = @() }

    foreach ($file in $Files) {
        $relPath = $file.RelativePath
        $excludeReason = $null

        # Step 1: target include (whitelist)
        $passesInclude = $false
        foreach ($pattern in $includePatterns) {
            if (Test-GlobMatch -Path $relPath -Patterns @($pattern)) {
                $passesInclude = $true
                break
            }
        }
        if (-not $passesInclude) {
            $excludeReason = 'target include'
        }

        # Step 2: target exclude (blacklist)
        if ($null -eq $excludeReason -and $excludePatterns.Count -gt 0) {
            if (Test-GlobMatch -Path $relPath -Patterns $excludePatterns) {
                $excludeReason = 'target exclude'
            }
        }

        if ($excludeReason) {
            $result.Excluded += [PSCustomObject]@{
                File   = $file
                Reason = $excludeReason
            }
        } else {
            $result.Included += $file
        }
    }

    return $result
}

function Test-BreakingChange {
    param([string]$SourcePath, [string]$TargetPath)
    $structuralPattern = '^\s{0,3}(#{1,6}\s|-\s\*\*\[|##\s)'
    try {
        $sourceLines = Get-Content -LiteralPath $SourcePath -Encoding UTF8
        $targetLines = Get-Content -LiteralPath $TargetPath -Encoding UTF8
        $sourceStructural = $sourceLines | Where-Object { $_ -match $structuralPattern } | ForEach-Object { $_.Trim() }
        $targetStructural = $targetLines | Where-Object { $_ -match $structuralPattern } | ForEach-Object { $_.Trim() }
        $removedFromSource = $targetStructural | Where-Object { $_ -notin $sourceStructural }
        return $removedFromSource.Count -gt 0
    } catch {
        return $false
    }
}

function Compare-Files {
    param(
        [array]$SourceFiles,
        [string]$TargetRoot,
        [string[]]$Deprecated,
        [string[]]$NeverOverwrite,
        [string]$LastSync
    )
    $targetRootFull = [System.IO.Path]::GetFullPath($TargetRoot)
    $results = @()

    # Classify source files
    foreach ($file in $SourceFiles) {
        $relPath = $file.RelativePath
        $targetPath = [System.IO.Path]::Combine($targetRootFull, ($relPath -replace '/', '\'))
        $isNeverOverwrite = Test-GlobMatch -Path $relPath -Patterns $NeverOverwrite

        if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            $sourceHash = Get-FileHash256 -Path $file.FullPath
            $targetHash = Get-FileHash256 -Path $targetPath
            if ($sourceHash -eq $targetHash) {
                $results += [PSCustomObject]@{
                    Action = 'UNCHANGED'
                    RelativePath = $relPath
                    SourcePath = $file.FullPath
                    TargetPath = $targetPath
                }
            } else {
                if ($isNeverOverwrite) {
                    $results += [PSCustomObject]@{
                        Action = 'SKIP'
                        RelativePath = $relPath
                        Reason = 'never_overwrite'
                        SourcePath = $file.FullPath
                        TargetPath = $targetPath
                    }
                } else {
                    $isLocallyModified = $false
                    if ($LastSync) {
                        try {
                            $lastSyncDate = [datetime]::Parse($LastSync)
                            $targetLastWrite = (Get-Item -LiteralPath $targetPath).LastWriteTime
                            if ($targetLastWrite -gt $lastSyncDate) {
                                $isLocallyModified = $true
                            }
                        } catch {
                            # Invalid last_sync format, skip check
                        }
                    }

                    if ($isLocallyModified) {
                        $isBreaking = Test-BreakingChange -SourcePath $file.FullPath -TargetPath $targetPath
                        if ($isBreaking) {
                            $results += [PSCustomObject]@{
                                Action = 'BREAKING_CHANGE'
                                RelativePath = $relPath
                                SourcePath = $file.FullPath
                                TargetPath = $targetPath
                            }
                        } else {
                            $results += [PSCustomObject]@{
                                Action = 'LOCALLY_MODIFIED'
                                RelativePath = $relPath
                                SourcePath = $file.FullPath
                                TargetPath = $targetPath
                            }
                        }
                    } else {
                        $results += [PSCustomObject]@{
                            Action = 'MODIFY'
                            RelativePath = $relPath
                            SourcePath = $file.FullPath
                            TargetPath = $targetPath
                        }
                    }
                }
            }
        } else {
            if ($isNeverOverwrite) {
                $results += [PSCustomObject]@{
                    Action = 'SKIP'
                    RelativePath = $relPath
                    Reason = 'never_overwrite'
                    SourcePath = $file.FullPath
                    TargetPath = $targetPath
                }
            } else {
                $results += [PSCustomObject]@{
                    Action = 'ADD'
                    RelativePath = $relPath
                    SourcePath = $file.FullPath
                    TargetPath = $targetPath
                }
            }
        }
    }

    # Check deprecated files at target
    if ($Deprecated -and $Deprecated.Count -gt 0) {
        $targetFiles = @()
        if (Test-Path -LiteralPath $targetRootFull) {
            $targetFiles = [System.IO.Directory]::EnumerateFiles(
                $targetRootFull,
                '*',
                [System.IO.SearchOption]::AllDirectories
            )
        }
        foreach ($targetFullPath in $targetFiles) {
            $relPath = Get-RelativePath -BasePath $targetRootFull -FullPath $targetFullPath
            $relPath = $relPath -replace '\\', '/'
            if (Test-GlobMatch -Path $relPath -Patterns $Deprecated) {
                $isNeverOverwrite = Test-GlobMatch -Path $relPath -Patterns $NeverOverwrite
                if ($isNeverOverwrite) {
                    $results += [PSCustomObject]@{
                        Action = 'SKIP'
                        RelativePath = $relPath
                        Reason = 'never_overwrite protects deletion'
                        SourcePath = $null
                        TargetPath = $targetFullPath
                    }
                } else {
                    $results += [PSCustomObject]@{
                        Action = 'DELETE'
                        RelativePath = $relPath
                        SourcePath = $null
                        TargetPath = $targetFullPath
                    }
                }
            }
        }
    }

    return $results
}

function Get-Header {
    param([string]$Title)
    $line = "=" * 100
    $startIdx = $line.IndexOf('=') + 30
    $headerText = " START: $Title "
    $endIdx = $startIdx + $headerText.Length
    $header = $line.Substring(0, $startIdx) + $headerText + $line.Substring($endIdx)
    if ($header.Length -gt 100) { $header = $header.Substring(0, 100) }
    while ($header.Length -lt 100) { $header += '=' }
    return $header
}

function Get-Footer {
    param([string]$Title)
    $line = "=" * 100
    $footerText = " END: $Title "
    $startIdx = 32
    $endIdx = $startIdx + $footerText.Length
    $footer = $line.Substring(0, $startIdx) + $footerText + $line.Substring($endIdx)
    if ($footer.Length -gt 100) { $footer = $footer.Substring(0, 100) }
    while ($footer.Length -lt 100) { $footer += '=' }
    return $footer
}

function Format-Duration {
    param([double]$Seconds)
    if ($Seconds -lt 60) {
        return "$([math]::Round($Seconds, 1)) secs"
    }
    if ($Seconds -lt 3600) {
        $mins = [int]($Seconds / 60)
        $secs = [int]($Seconds % 60)
        return "$mins mins $secs secs"
    }
    $hours = [int]($Seconds / 3600)
    $mins = [int](($Seconds % 3600) / 60)
    return "$hours hour$(if ($hours -ne 1) {'s'}) $mins mins"
}

function New-PreviewReport {
    param(
        [array]$Results,
        [string]$TargetPath,
        [array]$Excluded
    )
    $sb = [System.Text.StringBuilder]::new()

    $adds = $Results | Where-Object { $_.Action -eq 'ADD' }
    $modifies = $Results | Where-Object { $_.Action -eq 'MODIFY' }
    $deletes = $Results | Where-Object { $_.Action -eq 'DELETE' }
    $skips = $Results | Where-Object { $_.Action -eq 'SKIP' }
    $unchanged = $Results | Where-Object { $_.Action -eq 'UNCHANGED' }
    $locallyModified = $Results | Where-Object { $_.Action -eq 'LOCALLY_MODIFIED' }

    $totalChanges = $adds.Count + $modifies.Count + $locallyModified.Count + $deletes.Count + $skips.Count

    if ($totalChanges -eq 0 -and $Excluded.Count -eq 0) {
        [void]$sb.AppendLine("$TargetPath")
        [void]$sb.AppendLine("  OK. $($unchanged.Count) files unchanged, up to date.")
        return $sb.ToString()
    }

    [void]$sb.AppendLine("$TargetPath")

    if ($adds.Count -gt 0) {
        [void]$sb.AppendLine("  - Add: $($adds.Count) new files")
        foreach ($f in $adds) {
            $relPath = $f.RelativePath -replace '/', '\'
            [void]$sb.AppendLine("      $relPath")
        }
    }

    if ($modifies.Count -gt 0) {
        [void]$sb.AppendLine("  - Overwrite: $($modifies.Count) older files")
        foreach ($f in $modifies) {
            $relPath = $f.RelativePath -replace '/', '\'
            [void]$sb.AppendLine("      $relPath")
        }
    }

    if ($locallyModified.Count -gt 0) {
        [void]$sb.AppendLine("  - Overwrite: $($locallyModified.Count) locally-modified files")
        foreach ($f in $locallyModified) {
            $relPath = $f.RelativePath -replace '/', '\'
            [void]$sb.AppendLine("      $relPath")
        }
    }

    if ($deletes.Count -gt 0) {
        [void]$sb.AppendLine("  - Delete: $($deletes.Count) deprecated files")
        foreach ($f in $deletes) {
            $relPath = $f.RelativePath -replace '/', '\'
            [void]$sb.AppendLine("      $relPath")
        }
    }

    if ($skips.Count -gt 0) {
        $skipPaths = $skips | ForEach-Object { $_.RelativePath -replace '/', '\' }
        [void]$sb.AppendLine("  - Skipped: $($skips.Count) files protected (never_overwrite)")
        foreach ($p in $skipPaths) {
            [void]$sb.AppendLine("      $p")
        }
    }

    if ($Excluded.Count -gt 0) {
        $excludedSkills = @()
        foreach ($ex in $Excluded) {
            $relPath = $ex.File.RelativePath
            if ($relPath -match '^skills/([^/]+)/') {
                $skillName = $Matches[1]
                if ($skillName -notin $excludedSkills) { $excludedSkills += $skillName }
            }
        }
        if ($excludedSkills.Count -gt 0) {
            [void]$sb.AppendLine("  - Excluded skills: $($excludedSkills -join ', ')")
        }
    }

    return $sb.ToString()
}

function New-MarkdownPreview {
    param(
        [array]$AllTargetResults,
        [array]$DeprecatedFiles,
        [string]$SourcePath,
        [int]$TargetCount
    )
    $sb = [System.Text.StringBuilder]::new()

    $targetWord = if ($TargetCount -eq 1) { 'target' } else { 'targets' }
[void]$sb.AppendLine("# Sync Preview: $SourcePath to $TargetCount $targetWord")
    [void]$sb.AppendLine('')

    # Deprecated files section
    if ($DeprecatedFiles -and $DeprecatedFiles.Count -gt 0) {
        [void]$sb.AppendLine('## Deprecated Files (from promptsystem-sync.json top-level)')
        [void]$sb.AppendLine('')
        foreach ($dep in $DeprecatedFiles) {
            $depPath = $dep -replace '/', '\'
            [void]$sb.AppendLine("- $depPath")
        }
        [void]$sb.AppendLine('')
    }

    # Per-target preview
    [void]$sb.AppendLine('## Per-Target Preview')
    [void]$sb.AppendLine('')

    $totalDeploy = 0
    $totalDelete = 0

    foreach ($tgtResult in $AllTargetResults) {
        $preview = New-PreviewReport -Results $tgtResult.Results -TargetPath $tgtResult.Path -Excluded $tgtResult.Excluded
        [void]$sb.AppendLine($preview)
        [void]$sb.AppendLine('')

        $adds = $tgtResult.Results | Where-Object { $_.Action -eq 'ADD' }
        $modifies = $tgtResult.Results | Where-Object { $_.Action -eq 'MODIFY' }
        $locallyModified = $tgtResult.Results | Where-Object { $_.Action -eq 'LOCALLY_MODIFIED' }
        $deletes = $tgtResult.Results | Where-Object { $_.Action -eq 'DELETE' }
        $totalDeploy += $adds.Count + $modifies.Count + $locallyModified.Count
        $totalDelete += $deletes.Count
    }

    # Summary
    [void]$sb.AppendLine('## Summary')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("$TargetCount repos to process, $totalDeploy files to deploy, $totalDelete files to delete.")

    return $sb.ToString()
}

function New-DiffReport {
    param(
        [array]$Results,
        [string]$SourcePath,
        [string]$TargetPath,
        [string]$ConfigPath,
        [array]$Excluded,
        [bool]$VerboseMode,
        [datetime]$StartTime
    )
    $sb = [System.Text.StringBuilder]::new()
    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

    $adds = @($Results | Where-Object { $_.Action -eq 'ADD' })
    $modifies = @($Results | Where-Object { $_.Action -eq 'MODIFY' })
    $deletes = @($Results | Where-Object { $_.Action -eq 'DELETE' })
    $skips = @($Results | Where-Object { $_.Action -eq 'SKIP' })
    $unchanged = @($Results | Where-Object { $_.Action -eq 'UNCHANGED' })
    $locallyModified = @($Results | Where-Object { $_.Action -eq 'LOCALLY_MODIFIED' })
    $breakingChanges = @($Results | Where-Object { $_.Action -eq 'BREAKING_CHANGE' })

    [void]$sb.AppendLine((Get-Header -Title 'WORKSPACE SYNC PREVIEW'))
    [void]$sb.AppendLine("[$timestamp]")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("Syncing from '$SourcePath' to '$TargetPath'...")
    [void]$sb.AppendLine("  Reading '$ConfigPath'...")
    [void]$sb.AppendLine('    OK.')

    $totalChanges = $adds.Count + $modifies.Count + $locallyModified.Count + $breakingChanges.Count + $deletes.Count + $skips.Count
    $hasChanges = $totalChanges -gt 0

    if ($adds.Count -gt 0) {
        [void]$sb.AppendLine('  Comparing files...')
        for ($i = 0; $i -lt $adds.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($adds.Count) ] Adding '$($adds[$i].RelativePath)'...")
        }
        [void]$sb.AppendLine("    $($adds.Count) new file$(if ($adds.Count -ne 1) {'s'}) found.")
    }

    if ($modifies.Count -gt 0) {
        [void]$sb.AppendLine('  Comparing modified files...')
        for ($i = 0; $i -lt $modifies.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($modifies.Count) ] '$($modifies[$i].RelativePath)' differs...")
        }
        [void]$sb.AppendLine("    $($modifies.Count) modified file$(if ($modifies.Count -ne 1) {'s'}) found.")
    }

    if ($locallyModified.Count -gt 0) {
        [void]$sb.AppendLine('  Checking locally-modified files...')
        for ($i = 0; $i -lt $locallyModified.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($locallyModified.Count) ] '$($locallyModified[$i].RelativePath)' LOCALLY_MODIFIED - will be overwritten...")
        }
        [void]$sb.AppendLine("    $($locallyModified.Count) locally-modified file$(if ($locallyModified.Count -ne 1) {'s'}) found.")
    }

    if ($breakingChanges.Count -gt 0) {
        [void]$sb.AppendLine('  WARNING: Breaking changes detected...')
        for ($i = 0; $i -lt $breakingChanges.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($breakingChanges.Count) ] '$($breakingChanges[$i].RelativePath)' BREAKING_CHANGE - content migration required before overwrite...")
        }
        [void]$sb.AppendLine("    $($breakingChanges.Count) breaking change$(if ($breakingChanges.Count -ne 1) {'s'}) detected.")
    }

    [void]$sb.AppendLine('  Checking deprecated files...')
    if ($deletes.Count -gt 0) {
        for ($i = 0; $i -lt $deletes.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($deletes.Count) ] '$($deletes[$i].RelativePath)' marked for deletion...")
        }
        [void]$sb.AppendLine("    $($deletes.Count) deprecated file$(if ($deletes.Count -ne 1) {'s'}) found.")
    } else {
        [void]$sb.AppendLine('    0 deprecated files found.')
    }

    [void]$sb.AppendLine('  Checking never-overwrite files...')
    if ($skips.Count -gt 0) {
        $skipPaths = $skips | ForEach-Object { "'$($_.RelativePath)'" }
        [void]$sb.AppendLine("    $($skips.Count) file$(if ($skips.Count -ne 1) {'s'}) protected: $($skipPaths -join ', ').")
    } else {
        [void]$sb.AppendLine('    0 files protected.')
    }

    if ($VerboseMode -and $Excluded.Count -gt 0) {
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine("EXCLUDED ($($Excluded.Count)):")
        for ($i = 0; $i -lt $Excluded.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("  [ $idx / $($Excluded.Count) ] '$($Excluded[$i].File.RelativePath)' excluded -> $($Excluded[$i].Reason).")
        }
        [void]$sb.AppendLine("  $($Excluded.Count) file$(if ($Excluded.Count -ne 1) {'s'}) excluded.")
    }

    [void]$sb.AppendLine('')
    $summaryParts = @()
    $summaryParts += "$($adds.Count) add"
    $summaryParts += "$($modifies.Count) modify"
    $summaryParts += "$($locallyModified.Count) locally_modified"
    $summaryParts += "$($breakingChanges.Count) breaking_change"
    $summaryParts += "$($deletes.Count) delete"
    $summaryParts += "$($skips.Count) skip"
    $summaryParts += "$($unchanged.Count) unchanged"
    [void]$sb.AppendLine("Summary: '$TargetPath' - $($summaryParts -join ', ').")

    if ($hasChanges) {
        [void]$sb.AppendLine('RESULT: CHANGES FOUND')
    } else {
        [void]$sb.AppendLine('RESULT: NO CHANGES')
    }

    $endTime = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    [void]$sb.AppendLine((Get-Footer -Title 'WORKSPACE SYNC PREVIEW'))
    [void]$sb.AppendLine("[$endTime] ($(Format-Duration -Seconds ((Get-Date) - $startTime).TotalSeconds))")

    return $sb.ToString()
}

function Invoke-Execute {
    param(
        [array]$Results,
        [string]$SourcePath,
        [string]$TargetPath,
        [string]$ConfigPath
    )
    $sb = [System.Text.StringBuilder]::new()
    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $startTime = Get-Date

    $adds = @($Results | Where-Object { $_.Action -eq 'ADD' })
    $modifies = @($Results | Where-Object { $_.Action -eq 'MODIFY' })
    $deletes = @($Results | Where-Object { $_.Action -eq 'DELETE' })
    $skips = @($Results | Where-Object { $_.Action -eq 'SKIP' })
    $locallyModified = @($Results | Where-Object { $_.Action -eq 'LOCALLY_MODIFIED' })
    $breakingChanges = @($Results | Where-Object { $_.Action -eq 'BREAKING_CHANGE' })

    [void]$sb.AppendLine((Get-Header -Title 'WORKSPACE SYNC EXECUTE'))
    [void]$sb.AppendLine("[$timestamp]")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("Syncing from '$SourcePath' to '$TargetPath'...")
    [void]$sb.AppendLine("  Reading '$ConfigPath'...")
    [void]$sb.AppendLine('    OK.')

    $hasErrors = $false

    # Adding files
    if ($adds.Count -gt 0) {
        [void]$sb.AppendLine('  Adding files...')
        for ($i = 0; $i -lt $adds.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($adds.Count) ] Copying '$($adds[$i].RelativePath)'...")
            $targetDir = [System.IO.Path]::GetDirectoryName($adds[$i].TargetPath)
            if (-not (Test-Path -LiteralPath $targetDir)) {
                New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
            }
            try {
                Copy-Item -LiteralPath $adds[$i].SourcePath -Destination $adds[$i].TargetPath -Force
                [void]$sb.AppendLine('      OK.')
            } catch {
                $hasErrors = $true
                [void]$sb.AppendLine("      ERROR: Failed to copy '$($adds[$i].RelativePath)' -> $($_.Exception.Message)")
            }
        }
        [void]$sb.AppendLine("    $($adds.Count) file$(if ($adds.Count -ne 1) {'s'}) added.")
    }

    # Modifying files (includes LOCALLY_MODIFIED and BREAKING_CHANGE - all get backup + overwrite)
    $allModifies = @($modifies) + @($locallyModified) + @($breakingChanges)
    if ($allModifies.Count -gt 0) {
        [void]$sb.AppendLine('  Modifying files...')
        for ($i = 0; $i -lt $allModifies.Count; $i++) {
            $idx = $i + 1
            $warningTag = if ($allModifies[$i].Action -eq 'LOCALLY_MODIFIED') { ' [LOCALLY_MODIFIED]' } elseif ($allModifies[$i].Action -eq 'BREAKING_CHANGE') { ' [BREAKING_CHANGE]' } else { '' }
            [void]$sb.AppendLine("    [ $idx / $($allModifies.Count) ] Updating '$($allModifies[$i].RelativePath)'$warningTag...")
            $backupPath = $allModifies[$i].TargetPath + '.tmp_bak'
            try {
                Copy-Item -LiteralPath $allModifies[$i].TargetPath -Destination $backupPath -Force
                Copy-Item -LiteralPath $allModifies[$i].SourcePath -Destination $allModifies[$i].TargetPath -Force
                Remove-Item -LiteralPath $backupPath -Force
                [void]$sb.AppendLine('      OK.')
            } catch {
                $hasErrors = $true
                if (Test-Path -LiteralPath $backupPath) {
                    Copy-Item -LiteralPath $backupPath -Destination $allModifies[$i].TargetPath -Force
                    Remove-Item -LiteralPath $backupPath -Force
                }
                [void]$sb.AppendLine("      ERROR: Failed to update '$($allModifies[$i].RelativePath)' -> $($_.Exception.Message)")
            }
        }
        [void]$sb.AppendLine("    $($allModifies.Count) file$(if ($allModifies.Count -ne 1) {'s'}) modified.")
    }

    # Deleting deprecated files
    if ($deletes.Count -gt 0) {
        [void]$sb.AppendLine('  Deleting deprecated files...')
        for ($i = 0; $i -lt $deletes.Count; $i++) {
            $idx = $i + 1
            [void]$sb.AppendLine("    [ $idx / $($deletes.Count) ] Deleting '$($deletes[$i].RelativePath)'...")
            try {
                Remove-Item -LiteralPath $deletes[$i].TargetPath -Force
                [void]$sb.AppendLine('      OK.')
            } catch {
                $hasErrors = $true
                [void]$sb.AppendLine("      ERROR: Failed to delete '$($deletes[$i].RelativePath)' -> $($_.Exception.Message)")
            }
        }
        [void]$sb.AppendLine("    $($deletes.Count) file$(if ($deletes.Count -ne 1) {'s'}) deleted.")
    }

    # Skipping protected files
    if ($skips.Count -gt 0) {
        [void]$sb.AppendLine('  Skipping protected files...')
        foreach ($skip in $skips) {
            [void]$sb.AppendLine("    SKIP: '$($skip.RelativePath)' -> $($skip.Reason).")
        }
    }

    # Update last_sync
    if (-not $hasErrors) {
        [void]$sb.AppendLine("  Updating 'last_sync' timestamp...")
        try {
            $utcTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
            Update-LastSync -ConfigPath $ConfigPath -Timestamp $utcTimestamp
            [void]$sb.AppendLine("    OK. last_sync='$utcTimestamp'.")
        } catch {
            $hasErrors = $true
            [void]$sb.AppendLine("      ERROR: Failed to update 'last_sync' -> $($_.Exception.Message)")
        }
    }

    $summaryParts = @()
    $summaryParts += "$($adds.Count) added"
    $summaryParts += "$($modifies.Count) modified"
    $summaryParts += "$($locallyModified.Count) locally_modified"
    $summaryParts += "$($breakingChanges.Count) breaking_change"
    $summaryParts += "$($deletes.Count) deleted"
    $summaryParts += "$($skips.Count) skipped"
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("Summary: '$TargetPath' - $($summaryParts -join ', ').")

    if ($hasErrors) {
        [void]$sb.AppendLine('RESULT: PARTIAL FAIL')
    } else {
        [void]$sb.AppendLine('RESULT: OK')
    }

    $endTime = (Get-Date)
    $duration = ($endTime - $startTime).TotalSeconds
    $endTimeStr = $endTime.ToString('yyyy-MM-dd HH:mm:ss')
    [void]$sb.AppendLine((Get-Footer -Title 'WORKSPACE SYNC EXECUTE'))
    [void]$sb.AppendLine("[$endTimeStr] ($(Format-Duration -Seconds $duration))")

    return @{
        Output = $sb.ToString()
        HasErrors = $hasErrors
    }
}

function Update-LastSync {
    param([string]$ConfigPath, [string]$Timestamp)
    $configRaw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
    $config = $configRaw | ConvertFrom-Json
    $config.last_sync = $Timestamp
    $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

function Write-VerboseLog {
    param([string]$Message)
    if ($showVerbose) {
        [Console]::Error.WriteLine($Message)
    }
}

# ============================================================
# Main Execution
# ============================================================

# Mode validation
if ($diff -and $execute) {
    Write-Error 'Cannot specify both -diff and -execute.'
    exit 2
}
if (-not $diff -and -not $execute) {
    Write-Error 'Must specify either -diff or -execute.'
    exit 2
}

# Config parameter validation
if ([string]::IsNullOrWhiteSpace($config)) {
    Write-Error 'Parameter -config is required.'
    exit 2
}

# Resolve config path
$configPath = [System.IO.Path]::GetFullPath($config)

# Read config
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Error "Config file not found: '$configPath'."
    exit 2
}
try {
    $configRaw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($configRaw)) {
        Write-Error "Config file is empty: '$configPath'."
        exit 2
    }
    $syncConfig = $configRaw | ConvertFrom-Json
} catch {
    Write-Error "Invalid JSON in config: '$configPath'."
    exit 2
}

# Config must be a JSON object (PSCustomObject), not array/string/number
if ($null -eq $syncConfig -or $syncConfig.GetType().Name -ne 'PSCustomObject') {
    Write-Error "Config must be a JSON object: '$configPath'."
    exit 2
}

# Validate config
Test-SyncConfig -Config $syncConfig -ConfigPath $configPath

# Reverse mode: enforce 1:1 (exactly one target)
if ($reverse -and $syncConfig.targets.Count -gt 1) {
    Write-Error 'Reverse sync is 1:1. Specify exactly one target to sync back from.'
    exit 2
}

# Config directory for resolving relative paths
$configDir = [System.IO.Path]::GetDirectoryName($configPath)

# Top-level deprecated array (shared across all targets)
$deprecatedList = @()
if ($syncConfig.deprecated) {
    $deprecatedList = @($syncConfig.deprecated)
}

$startTime = Get-Date
$allOutput = [System.Text.StringBuilder]::new()
$allTargetResults = @()
$hasAnyChanges = $false
$hasAnyErrors = $false

# Iterate targets array
foreach ($tgtEntry in $syncConfig.targets) {
    # Resolve target path relative to config file's directory
    $targetPath = if ([System.IO.Path]::IsPathRooted($tgtEntry.path)) {
        $tgtEntry.path
    } else {
        [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($configDir, $tgtEntry.path))
    }

    # Resolve source path relative to config file's directory
    $sourcePath = if ([System.IO.Path]::IsPathRooted($tgtEntry.source)) {
        $tgtEntry.source
    } else {
        [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($configDir, $tgtEntry.source))
    }

    # Self-sync detection: source and target resolve to same path (case-insensitive on Windows)
    $pathComparison = if ($IsLinux -or $IsMacOS) {
        [System.String]::Compare($sourcePath, $targetPath, $false)
    } else {
        [System.String]::Compare($sourcePath, $targetPath, $true)
    }
    if ($pathComparison -eq 0) {
        Write-Error "Source and target resolve to the same path: '$targetPath'. Self-sync is not allowed."
        exit 2
    }

    if ($reverse) {
        # Reverse mode: swap source and target
        # Source files come from targetPath (downstream), compare against sourcePath (upstream)
        $enumPath = $targetPath
        $compareRoot = $sourcePath

        # Check enum path exists and is a directory
        if (-not (Test-Path -LiteralPath $enumPath)) {
            [void]$allOutput.AppendLine("ERROR: Source path not found: '$enumPath' for reverse sync.")
            Write-Error "Source path not found: '$enumPath' for reverse sync."
            $hasAnyErrors = $true
            continue
        }
        if (Test-Path -LiteralPath $enumPath -PathType Leaf) {
            [void]$allOutput.AppendLine("ERROR: Source path is a file, not a directory: '$enumPath' for reverse sync.")
            Write-Error "Source path is a file, not a directory: '$enumPath' for reverse sync."
            $hasAnyErrors = $true
            continue
        }

        # Check compare root exists (create if missing for execute mode)
        if (-not (Test-Path -LiteralPath $compareRoot -PathType Container) -and $execute) {
            New-Item -ItemType Directory -Path $compareRoot -Force | Out-Null
        }

        # Discover files from target (downstream) - no filtering in reverse
        $allFiles = Get-SourceFiles -SourceRoot $enumPath
        $filterResult = @{ Included = $allFiles; Excluded = @() }

        Write-VerboseLog "Reverse sync: source='$($tgtEntry.path)' target='$($tgtEntry.source)'..."
        Write-VerboseLog "  total_files=$($allFiles.Count)"

        # No never_overwrite in reverse, no exclude filtering
        $results = Compare-Files -SourceFiles $allFiles -TargetRoot $compareRoot -Deprecated $deprecatedList -NeverOverwrite @() -LastSync $syncConfig.last_sync

        # Collect for markdown preview
        $allTargetResults += @{
            Path = $tgtEntry.source
            Results = $results
            Excluded = @()
        }

        # Check for changes
        $changes = @($results | Where-Object { $_.Action -in @('ADD', 'MODIFY', 'LOCALLY_MODIFIED', 'BREAKING_CHANGE', 'DELETE', 'SKIP') })
        if ($changes.Count -gt 0) { $hasAnyChanges = $true }

        if ($diff) {
            $report = New-DiffReport -Results $results -SourcePath $targetPath -TargetPath $sourcePath -ConfigPath $configPath -Excluded @() -VerboseMode:$showVerbose -StartTime $startTime
            [void]$allOutput.AppendLine($report)
            [void]$allOutput.AppendLine('')
        } elseif ($execute) {
            $execResult = Invoke-Execute -Results $results -SourcePath $targetPath -TargetPath $sourcePath -ConfigPath $configPath
            [void]$allOutput.AppendLine($execResult.Output)
            [void]$allOutput.AppendLine('')
            if ($execResult.HasErrors) { $hasAnyErrors = $true }
        }
    } else {
        # Forward mode (original logic)
        # Check source exists and is a directory
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            [void]$allOutput.AppendLine("ERROR: Source path not found: '$sourcePath' for target '$($tgtEntry.path)'.")
            Write-Error "Source path not found: '$sourcePath' for target '$($tgtEntry.path)'."
            $hasAnyErrors = $true
            continue
        }
        if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
            [void]$allOutput.AppendLine("ERROR: Source path is a file, not a directory: '$sourcePath' for target '$($tgtEntry.path)'.")
            Write-Error "Source path is a file, not a directory: '$sourcePath' for target '$($tgtEntry.path)'."
            $hasAnyErrors = $true
            continue
        }

        # Check target exists (create if missing for execute mode)
        $targetExists = Test-Path -LiteralPath $targetPath -PathType Container
        if (-not $targetExists -and $execute) {
            New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
            $targetExists = $true
        }

        # Discover and filter source files
        $allFiles = Get-SourceFiles -SourceRoot $sourcePath
        $filterResult = Invoke-FileFilter -TargetEntry $tgtEntry -Files $allFiles

        Write-VerboseLog "Target: path='$($tgtEntry.path)'..."
        Write-VerboseLog "  source='$sourcePath'"
        Write-VerboseLog "  total_files=$($allFiles.Count)"
        Write-VerboseLog "  included=$($filterResult.Included.Count)"
        Write-VerboseLog "  excluded=$($filterResult.Excluded.Count)"

        # Compare against target
        $neverOverwrite = @($tgtEntry.never_overwrite)
        if (-not $neverOverwrite) { $neverOverwrite = @() }

        $results = Compare-Files -SourceFiles $filterResult.Included -TargetRoot $targetPath -Deprecated $deprecatedList -NeverOverwrite $neverOverwrite -LastSync $syncConfig.last_sync

        # Collect for markdown preview
        $allTargetResults += @{
            Path = $tgtEntry.path
            Results = $results
            Excluded = $filterResult.Excluded
        }

        # Check for changes
        $changes = @($results | Where-Object { $_.Action -in @('ADD', 'MODIFY', 'LOCALLY_MODIFIED', 'BREAKING_CHANGE', 'DELETE', 'SKIP') })
        if ($changes.Count -gt 0) { $hasAnyChanges = $true }

        if ($diff) {
            $report = New-DiffReport -Results $results -SourcePath $sourcePath -TargetPath $targetPath -ConfigPath $configPath -Excluded $filterResult.Excluded -VerboseMode:$showVerbose -StartTime $startTime
            [void]$allOutput.AppendLine($report)
            [void]$allOutput.AppendLine('')
        } elseif ($execute) {
            $execResult = Invoke-Execute -Results $results -SourcePath $sourcePath -TargetPath $targetPath -ConfigPath $configPath
            [void]$allOutput.AppendLine($execResult.Output)
            [void]$allOutput.AppendLine('')
            if ($execResult.HasErrors) { $hasAnyErrors = $true }
        }
    }
}

# Output
$outputContent = $allOutput.ToString().TrimEnd()

# Write markdown preview file if requested (diff mode only)
if ($preview_file -and $diff) {
    $previewFileFull = [System.IO.Path]::GetFullPath($preview_file)
    $firstSource = if ($syncConfig.targets.Count -gt 0) { $syncConfig.targets[0].source } else { 'unknown' }
    $markdownPreview = New-MarkdownPreview -AllTargetResults $allTargetResults -DeprecatedFiles $deprecatedList -SourcePath $firstSource -TargetCount $syncConfig.targets.Count
    $markdownPreview | Set-Content -Path $previewFileFull -Encoding UTF8
    Write-Output "Preview written to: '$previewFileFull'."
}

if ($output_file) {
    $outputFileFull = [System.IO.Path]::GetFullPath($output_file)
    $outputContent | Set-Content -Path $outputFileFull -Encoding UTF8
    Write-Output "Summary: see full report at '$outputFileFull'."
} else {
    Write-Output $outputContent
}

# Exit codes
if ($hasAnyErrors) {
    exit 5
}
if ($hasAnyChanges) {
    exit 1
}
exit 0
