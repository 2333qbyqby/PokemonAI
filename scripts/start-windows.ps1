param([switch]$NoBrowser)

. (Join-Path $PSScriptRoot 'common.ps1')

function Get-ListeningPortForProcess([int]$ProcessId) {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
    $processIds = @($ProcessId)
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    do {
        $childIds = @($processes |
            Where-Object { $processIds -contains [int]$_.ParentProcessId } |
            Select-Object -ExpandProperty ProcessId |
            Where-Object { $processIds -notcontains [int]$_ })
        $processIds += $childIds
    } while ($childIds.Count)
    foreach ($candidatePid in $processIds) {
        $port = Get-NetTCPConnection -State Listen -OwningProcess $candidatePid -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty LocalPort -First 1
        if ($port) { return $port }
    }
    return $null
}

function Get-AvailablePort([int[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if (-not (Test-TcpPort '127.0.0.1' $candidate)) { return $candidate }
    }
    throw "No available local port in range $($Candidates[0])-$($Candidates[-1])."
}

try {
    $webPidFile = Join-Path $PidRoot 'control-plane.pid'
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

    $requiredRuntimeFiles = @($NodeExe, $ControlPython)
    $runtimeReady = -not ($requiredRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
    if (-not $runtimeReady) {
        Write-Host 'First launch: preparing the project-local runtime. This can take several minutes.' -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot 'bootstrap.ps1')
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
    }
    & (Join-Path $PSScriptRoot 'start-local.ps1') @startArguments
} catch {
    Write-Host ''
    Write-Host "PokemonAI failed to start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
