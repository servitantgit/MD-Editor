<#
.SYNOPSIS
    Export MD-Editor source into a plain-text file for pasting into an AI chat.
.DESCRIPTION
    Writes md-editor-<preset>.txt to the real Desktop (outside the repo).
    Each file is preceded by '===== FILE: <relative/path> ====='.
    Secrets (.env*, .dev.vars*, *secret*, *.pem, *.key) are ALWAYS excluded.
.EXAMPLE
    .\tools\export-code.ps1 -Preset core2
.EXAMPLE
    .\tools\export-code.ps1 -Paths "js/html-preview.js","test/*preview*.js"
#>
param(
    [ValidateSet('core1','core2','tests','css','all')]
    [string]$Preset = 'core2',
    [string[]]$Paths,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
if (-not $OutputDir) { $OutputDir = [Environment]::GetFolderPath('Desktop') }

# --- Presets ---------------------------------------------------------------
$Core1 = @('js/app.js', 'js/editor.js', 'js/file-ops.js')
$Presets = @{
    core1 = @{ Include = $Core1; Exclude = @() }
    core2 = @{ Include = @('js/*.js', 'functions/*.js', 'functions/*.ts', 'index.html', 'package.json');
               Exclude = $Core1 + @('js/demo-client.js') }
    tests = @{ Include = @('test/*.js'); Exclude = @() }
    css   = @{ Include = @('css/*.css'); Exclude = @() }
    all   = @{ Include = @('js/*.js', 'functions/*.js', 'functions/*.ts', 'index.html', 'package.json');
               Exclude = @('js/demo-client.js') }
}

if ($Paths) {
    $inc = $Paths; $exc = @(); $name = 'custom'
} else {
    $inc = $Presets[$Preset].Include; $exc = $Presets[$Preset].Exclude; $name = $Preset
}

# --- Exclusions ------------------------------------------------------------
$ExcludedDirs   = @('.git', 'node_modules', '.wrangler', '.vscode', '.idea')
$SecretPatterns = @('.env*', '.dev.vars*', '*secret*', '*.pem', '*.key')

# --- Collect files ---------------------------------------------------------
$files = @(
    Get-ChildItem -LiteralPath $ProjectRoot -Force |
    Where-Object { $ExcludedDirs -notcontains $_.Name } |
    ForEach-Object {
        if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force } else { $_ }
    } |
    ForEach-Object {
        $rel = $_.FullName.Substring($ProjectRoot.Length + 1) -replace '\\', '/'
        [PSCustomObject]@{ FullName = $_.FullName; Rel = $rel; Name = $_.Name }
    } |
    Where-Object {
        $r = $_.Rel; $n = $_.Name
        (@($r -split '/' | Where-Object { $ExcludedDirs -contains $_ }).Count -eq 0) -and
        (-not ($SecretPatterns | Where-Object { $n -like $_ })) -and
        ($inc | Where-Object { $r -like $_ }) -and
        (-not ($exc | Where-Object { $r -like $_ }))
    } |
    Sort-Object Rel
)

if ($files.Count -eq 0) {
    Write-Warning "No files matched. Nothing written."
    exit 1
}

# --- Header ----------------------------------------------------------------
$commit = 'unknown'
try {
    $c = git -C $ProjectRoot rev-parse --short HEAD 2>$null
    if ($c) { $commit = $c }
} catch { }

# --- Write -----------------------------------------------------------------
$sb = New-Object System.Text.StringBuilder
$null = $sb.AppendLine("# MD-Editor export | preset: $name | commit: $commit | $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
$null = $sb.AppendLine("# Files: $($files.Count)")
$null = $sb.AppendLine()

foreach ($f in $files) {
    $null = $sb.AppendLine("===== FILE: $($f.Rel) =====")
    try {
        $content = [System.IO.File]::ReadAllText($f.FullName, $enc)
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`n" }
        $null = $sb.Append($content)
    } catch {
        $null = $sb.AppendLine("[ERROR READING FILE: $($_.Exception.Message)]")
    }
    $null = $sb.AppendLine()
}

$out = Join-Path $OutputDir "md-editor-$name.txt"
[System.IO.File]::WriteAllText($out, $sb.ToString(), $enc)

# --- Summary ---------------------------------------------------------------
$chars = $sb.Length
Write-Host "Export completed."
Write-Host "  Preset:  $name"
Write-Host "  Commit:  $commit"
Write-Host "  Files:   $($files.Count)"
$files | ForEach-Object { Write-Host "    $($_.Rel)" }
Write-Host "  Output:  $out"
Write-Host ("  Size:    {0:N0} chars (~{1:N0} tokens, rough)" -f $chars, ($chars / 4))
if ($chars -gt 400000) {
    Write-Warning "Over ~400k chars. Consider a smaller preset or -Paths."
}
