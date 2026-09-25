[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][int]$FirstLine,
  [Parameter(Mandatory)][int]$LastLine,
  [string]$SourceStyle = 'detect',
  [string]$TargetStyle = 'unicode-normal',
  [string]$OutputFile,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$Styles = @{
  'plain-normal'  = @{ TL='+';TR='+';BL='+';BR='+';H='-';V='|';TJ='+';BU='+';TLJ='+';TRJ='+';CR='+' }
  'plain-dotted'  = @{ TL='+';TR='+';BL='+';BR='+';H='.';V=':';TJ='+';BU='+';TLJ='+';TRJ='+';CR='+' }
  'plain-dashed'  = @{ TL='+';TR='+';BL='+';BR='+';H='-';V="'";TJ='+';BU='+';TLJ='+';TRJ='+';CR='+' }
  'plain-double'  = @{ TL='+';TR='+';BL='+';BR='+';H='=';V='|';TJ='+';BU='+';TLJ='+';TRJ='+';CR='+' }
  'plain-rounded' = @{ TL=',';TR='.';BL='`';BR="'";H='-';V='|';TJ=',';BU='.';TLJ=',';TRJ='.';CR='+' }
  'unicode-normal'  = @{ TL='┌';TR='┐';BL='└';BR='┘';H='─';V='│';TJ='┬';BU='┴';TLJ='├';TRJ='┤';CR='┼' }
  'unicode-dotted'  = @{ TL='┌';TR='┐';BL='└';BR='┘';H='┄';V='┆';TJ='┬';BU='┴';TLJ='├';TRJ='┤';CR='┼' }
  'unicode-dashed'  = @{ TL='┌';TR='┐';BL='└';BR='┘';H='╌';V='╎';TJ='┬';BU='┴';TLJ='├';TRJ='┤';CR='┼' }
  'unicode-double'  = @{ TL='╔';TR='╗';BL='╚';BR='╝';H='═';V='║';TJ='╦';BU='╩';TLJ='╠';TRJ='╣';CR='╬' }
  'unicode-heavy'   = @{ TL='┏';TR='┓';BL='┗';BR='┛';H='━';V='┃';TJ='┳';BU='┻';TLJ='┣';TRJ='┫';CR='╋' }
  'unicode-rounded' = @{ TL='╭';TR='╮';BL='╰';BR='╯';H='─';V='│';TJ='┬';BU='┴';TLJ='├';TRJ='┤';CR='┼' }
}

function Get-StyleChars([hashtable]$Def) {
  $set = @{}
  foreach ($k in $Def.Keys) { if ($k -ne 'Dashed') { $set[$Def[$k]] = $true } }
  return $set
}

function Detect-Style([string[]]$Lines) {
  $t = $Lines -join "`n"
  if ($t -match '[╔╗╚╝]') { return 'unicode-double' }
  if ($t -match '[┏┓┗┛]') { return 'unicode-heavy' }
  if ($t -match '[╭╮╰╯]') { return 'unicode-rounded' }
  if ($t -match '[┌┐└┘]') {
    if ($t -match '[┄┆]') { return 'unicode-dotted' }
    if ($t -match '[╌╎]') { return 'unicode-dashed' }
    return 'unicode-normal'
  }
  if ($t -match '(?m)^\s*[,`]-') { return 'plain-rounded' }
  if ($t -match '\+\.{2,}\+' -or ($t -match '(?m)^\s*:.*:\s*$')) { return 'plain-dotted' }
  if ($t -match "(?m)^\s*'.*'\s*$") { return 'plain-dashed' }
  if ($t -match '\+={2,}\+') { return 'plain-double' }
  return 'plain-normal'
}

function Has-BoxNeighbor([int]$Row,[int]$Col,[string[]]$Lines,[hashtable]$SrcChars) {
  $ln = $Lines[$Row]
  if ($Col -gt 0 -and $Col -le $ln.Length -and $SrcChars.ContainsKey([string]$ln[$Col-1])) { return $true }
  if ($Col -ge 0 -and $Col -lt $ln.Length-1 -and $SrcChars.ContainsKey([string]$ln[$Col+1])) { return $true }
  if ($Row -gt 0 -and $Col -lt $Lines[$Row-1].Length -and $SrcChars.ContainsKey([string]$Lines[$Row-1][$Col])) { return $true }
  if ($Row -lt $Lines.Count-1 -and $Col -lt $Lines[$Row+1].Length -and $SrcChars.ContainsKey([string]$Lines[$Row+1][$Col])) { return $true }
  return $false
}

function Resolve-JunctionRole([int]$Row,[int]$Col,[string[]]$Lines,[hashtable]$Def,[hashtable]$SrcChars) {
  $H = $Def['H']; $V = $Def['V']
  $ln = $Lines[$Row]
  $hasHL = $false
  if ($Col -gt 0 -and $Col -le $ln.Length) {
    $lc = [string]$ln[$Col-1]
    if ($SrcChars.ContainsKey($lc) -and $lc -ne $V) { $hasHL = $true }
  }
  $hasHR = $false
  if ($Col -ge 0 -and $Col -lt $ln.Length-1) {
    $rc = [string]$ln[$Col+1]
    if ($SrcChars.ContainsKey($rc) -and $rc -ne $V) { $hasHR = $true }
  }
  $hasVA = $false
  if ($Row -gt 0 -and $Col -lt $Lines[$Row-1].Length) {
    $ac = [string]$Lines[$Row-1][$Col]
    if ($SrcChars.ContainsKey($ac) -and $ac -ne $H) { $hasVA = $true }
  }
  $hasVB = $false
  if ($Row -lt $Lines.Count-1 -and $Col -lt $Lines[$Row+1].Length) {
    $bc = [string]$Lines[$Row+1][$Col]
    if ($SrcChars.ContainsKey($bc) -and $bc -ne $H) { $hasVB = $true }
  }
  # Check if this is a tree branch: horizontal run to the right ends with >
  $isTreeBranch = $false
  if ($hasHR -and -not $hasHL) {
    $j = $Col + 1
    while ($j -lt $ln.Length -and $srcChars.ContainsKey([string]$ln[$j]) -and [string]$ln[$j] -ne $V) { $j++ }
    if ($j -lt $ln.Length -and [string]$ln[$j] -eq '>') { $isTreeBranch = $true }
  }
  # Tree branches: └─> or ├─> (even without vertical neighbors)
  if ($isTreeBranch) {
    if ($hasVB) { return 'TLJ' }
    return 'BL'
  }
  # No vertical neighbors: + is part of a horizontal line, not a junction
  if (-not $hasVA -and -not $hasVB) { return 'H' }
  # No horizontal neighbors: + is part of a vertical line, not a junction
  if (-not $hasHL -and -not $hasHR) { return 'V' }
  if ($hasHR -and -not $hasHL) {
    if ($hasVA -and $hasVB) { return 'TLJ' }
    if ($hasVA) { return 'BL' }
    return 'TL'
  }
  if ($hasHL -and -not $hasHR) {
    if ($hasVA -and $hasVB) { return 'TRJ' }
    if ($hasVA) { return 'BR' }
    return 'TR'
  }
  if ($hasHL -and $hasHR) {
    if ($hasVA -and $hasVB) { return 'CR' }
    if ($hasVA -and -not $hasVB) { return 'BU' }
    return 'TJ'
  }
  return 'CR'
}

function Convert-Lines([string[]]$Lines,[string]$SrcStyle,[string]$TgtStyle) {
  $srcDef = $Styles[$SrcStyle]
  $tgtDef = $Styles[$TgtStyle]
  $srcChars = Get-StyleChars $srcDef

  # Normalize plain-dashed: collapse " - " to "---" preserving width
  if ($SrcStyle -eq 'plain-dashed') {
    for ($i = 0; $i -lt $Lines.Count; $i++) {
      $Lines[$i] = [regex]::Replace($Lines[$i], '(?<=[+\-]) (?=[+\-])', '-')
    }
  }

  # Build reverse map: char -> role(s) for source style
  $charRole = @{}
  foreach ($r in $srcDef.Keys) {
    if ($r -eq 'Dashed') { continue }
    $c = $srcDef[$r]
    if (-not $charRole.ContainsKey($c)) { $charRole[$c] = @() }
    $charRole[$c] += $r
  }

  $result = [string[]]::new($Lines.Count)
  for ($row = 0; $row -lt $Lines.Count; $row++) {
    $chars = $Lines[$row].ToCharArray()
    for ($col = 0; $col -lt $chars.Length; $col++) {
      $c = [string]$chars[$col]
      if (-not $srcChars.ContainsKey($c)) { continue }
      # For junction chars (corners/crosses), use directional check:
      # H neighbors left/right, V neighbors above/below.
      # For H/V chars, any box-char neighbor suffices.
      $isJunctionChar = $charRole.ContainsKey($c) -and $charRole[$c].Count -gt 1
      if ($isJunctionChar) {
        $H = $srcDef['H']; $V = $srcDef['V']
        $ln = $Lines[$row]
        $hasBoxN = $false
        if ($col -gt 0 -and $col -le $ln.Length) { $lc = [string]$ln[$col-1]; if ($srcChars.ContainsKey($lc) -and $lc -ne $V) { $hasBoxN = $true } }
        if (-not $hasBoxN -and $col -ge 0 -and $col -lt $ln.Length-1) { $rc = [string]$ln[$col+1]; if ($srcChars.ContainsKey($rc) -and $rc -ne $V) { $hasBoxN = $true } }
        if (-not $hasBoxN -and $row -gt 0 -and $col -lt $Lines[$row-1].Length) { $ac = [string]$Lines[$row-1][$col]; if ($srcChars.ContainsKey($ac) -and $ac -ne $H) { $hasBoxN = $true } }
        if (-not $hasBoxN -and $row -lt $Lines.Count-1 -and $col -lt $Lines[$row+1].Length) { $bc = [string]$Lines[$row+1][$col]; if ($srcChars.ContainsKey($bc) -and $bc -ne $H) { $hasBoxN = $true } }
        if (-not $hasBoxN) { continue }
      } else {
        if (-not (Has-BoxNeighbor $row $col $Lines $srcChars)) { continue }
      }

      $role = $null
      $isJunction = $SrcStyle -like 'plain-*' -and $charRole.ContainsKey($c) -and $charRole[$c].Count -gt 1
      if ($isJunction) {
        $role = Resolve-JunctionRole $row $col $Lines $srcDef $srcChars
      }
      elseif ($charRole.ContainsKey($c)) {
        $role = $charRole[$c][0]
      }
      if ($role -and $tgtDef.ContainsKey($role)) {
        $chars[$col] = $tgtDef[$role][0]
      }
    }
    $result[$row] = [string]::new($chars)
  }
  return $result
}

# ── Main ──────────────────────────────────────────────────────────
$validStyles = $Styles.Keys + 'detect'
if ($SourceStyle -ne 'detect' -and -not $Styles.ContainsKey($SourceStyle)) {
  throw "Invalid SourceStyle '$SourceStyle'. Valid: $($validStyles -join ', ')"
}
if (-not $Styles.ContainsKey($TargetStyle)) {
  throw "Invalid TargetStyle '$TargetStyle'. Valid: $($Styles.Keys -join ', ')"
}

$enc = [System.Text.UTF8Encoding]::new($false)
$allLines = [System.IO.File]::ReadAllLines($Path, $enc)

if ($FirstLine -lt 1 -or $FirstLine -gt $allLines.Count) {
  throw "FirstLine $FirstLine out of range (1..$($allLines.Count))"
}
if ($LastLine -lt $FirstLine -or $LastLine -gt $allLines.Count) {
  throw "LastLine $LastLine out of range ($FirstLine..$($allLines.Count))"
}

$targetLines = $allLines[($FirstLine-1)..($LastLine-1)]

if ($SourceStyle -eq 'detect') {
  $SourceStyle = Detect-Style $targetLines
  Write-Host "Detected: $SourceStyle"
}

$converted = Convert-Lines $targetLines $SourceStyle $TargetStyle

for ($i = 0; $i -lt $converted.Count; $i++) {
  $allLines[$FirstLine-1+$i] = $converted[$i]
}

if ($DryRun) {
  Write-Host "[DryRun] Would convert lines $FirstLine-$LastLine : $SourceStyle -> $TargetStyle"
  for ($i = 0; $i -lt $converted.Count; $i++) {
    Write-Host "  $($FirstLine+$i): $($converted[$i])"
  }
} else {
  $outPath = if ($OutputFile) { $OutputFile } else { $Path }
  [System.IO.File]::WriteAllLines($outPath, $allLines, $enc)
  Write-Host "Converted lines $FirstLine-$LastLine : $SourceStyle -> $TargetStyle -> $outPath"
}
