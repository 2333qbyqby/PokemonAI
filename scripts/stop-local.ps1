. (Join-Path $PSScriptRoot 'common.ps1')

$pidFiles = if (Test-Path -LiteralPath $PidRoot) {
    @(Get-ChildItem -LiteralPath $PidRoot -Filter '*.pid')
} else {
    @()
}
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

# Node's Showdown workers and the Windows Python venv launcher can outlive the
# recorded parent PID. Limit cleanup to commands owned by this workspace.
$ownedMarkers = @(
    (Join-Path $ProjectRoot 'vendor\pokemon-showdown'),
    (Join-Path $ProjectRoot 'services\agent-runtime'),
    (Join-Path $ProjectRoot 'services\control-plane')
)
$ownedProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $commandLine = $_.CommandLine
    $_.Name -in @('node.exe', 'python.exe') -and $commandLine -and
    (($ownedMarkers | Where-Object { $commandLine.Contains($_) }) -or
        ($_.ExecutablePath -eq $NodeExe -and $commandLine.Contains('pokemon-showdown start')))
}
foreach ($owned in $ownedProcesses) {
    Write-Host "Stopping remaining $($owned.Name) process (PID $($owned.ProcessId))..."
    Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue
}
