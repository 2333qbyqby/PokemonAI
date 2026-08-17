. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path -LiteralPath $PidRoot)) {
    Write-Host 'No managed PokemonAI processes are recorded.'
    exit 0
}

$pidFiles = @(Get-ChildItem -LiteralPath $PidRoot -Filter '*.pid')
$pidFiles = @($pidFiles | Sort-Object { if ($_.BaseName -eq 'supervisor') { 0 } else { 1 } })
foreach ($pidFile in $pidFiles) {
    $name = $pidFile.BaseName
    try {
        $processId = [int](Get-Content -LiteralPath $pidFile.FullName -Raw)
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Write-Host "Stopping $name (PID $processId)..."
            Stop-Process -Id $processId -Force
        }
    } finally {
        Remove-Item -LiteralPath $pidFile.FullName -Force -ErrorAction SilentlyContinue
    }
}
