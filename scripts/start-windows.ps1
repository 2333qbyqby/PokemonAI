param(
    [switch]$NoBrowser,
    [switch]$SkipExpert
)

. (Join-Path $PSScriptRoot 'common.ps1')

function Get-ListeningPortForProcess([int]$ProcessId) {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
    return Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalPort -First 1
}

function Get-AvailablePort([int[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if (-not (Test-TcpPort '127.0.0.1' $candidate)) { return $candidate }
    }
    throw "No available local port in range $($Candidates[0])-$($Candidates[-1])."
}

try {
    $webPidFile = Join-Path $PidRoot 'web.pid'
    if (Test-Path -LiteralPath $webPidFile) {
        $runningWebPid = [int](Get-Content -LiteralPath $webPidFile -Raw)
        if (Get-Process -Id $runningWebPid -ErrorAction SilentlyContinue) {
            $runningPort = Get-ListeningPortForProcess $runningWebPid
            if ($runningPort) {
                $runningUrl = "http://127.0.0.1:$runningPort/"
                Write-Host "PokemonAI is already running: $runningUrl" -ForegroundColor Green
                if (-not $NoBrowser) { Start-Process $runningUrl }
                exit 0
            }
        }
    }

    $requiredRuntimeFiles = @($NodeExe, $BaselinePython)
    if (-not $SkipExpert) { $requiredRuntimeFiles += $FoulPlayPython }
    $runtimeReady = -not ($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    if (-not $runtimeReady) {
        Write-Host 'First launch: preparing the project-local runtime. This can take several minutes.' -ForegroundColor Cyan
        $bootstrapArguments = @{}
        if ($SkipExpert) { $bootstrapArguments.SkipExpert = $true }
        & (Join-Path $PSScriptRoot 'bootstrap.ps1') @bootstrapArguments
    }

    # Prefer the documented ports, then move to a nearby free port. This also
    # handles Windows machines where IIS has reserved port 8080 through HTTP.sys.
    $webPort = Get-AvailablePort (8080..8099)
    $showdownPort = Get-AvailablePort (8000..8019)
    if ($webPort -ne 8080 -or $showdownPort -ne 8000) {
        Write-Host "Default port is occupied; using web $webPort and Showdown $showdownPort." -ForegroundColor Yellow
    }

    $startArguments = @{
        WebPort = $webPort
        ShowdownPort = $showdownPort
        NoBrowser = $NoBrowser
        SkipExpert = $SkipExpert
    }
    & (Join-Path $PSScriptRoot 'start-local.ps1') @startArguments
} catch {
    Write-Host ''
    Write-Host "PokemonAI failed to start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
