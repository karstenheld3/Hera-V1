# Key-leak guard module (LANAV2DIST-IP01 IS-04, EC-04, IG-05).
# Extracted from build.ps1 for unit testability.
# Scans files for real-key-shaped *_API_KEY= assignments (40+ char token).
# Never reports the value, only the offending file path.

function Test-KeyLeakPath {
  param([string]$FilePath)
  $matches = Select-String -Path $FilePath -Pattern '[A-Z_]*API_KEY\s*=\s*[A-Za-z0-9_-]{40,}' -Quiet
  return $matches
}

function Get-KeyLeaks {
  param([string]$Path)
  Get-ChildItem $Path -Recurse -File | Where-Object {
    Test-KeyLeakPath -FilePath $_.FullName
  } | ForEach-Object FullName
}

Export-ModuleMember -Function Test-KeyLeakPath, Get-KeyLeaks
