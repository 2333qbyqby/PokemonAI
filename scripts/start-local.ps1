param(
    [switch]$ListenLan,
    [switch]$NoBrowser,
    [ValidateRange(1024, 65535)][int]$WebPort = 8080,
    [ValidateRange(1024, 65535)][int]$ShowdownPort = 8000
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-File $NodeExe 'Run scripts/bootstrap.ps1 first.'
Assert-File $ControlPython 'Run scripts/bootstrap.ps1 first.'

# Keep generated browser modules in sync for one-click development starts.
Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot -Script (Join-Path $ProjectRoot 'scripts\transpile-client.mjs')

if ((Test-TcpPort '127.0.0.1' $ShowdownPort) -or (Test-TcpPort '127.0.0.1' $WebPort)) {
    throw "Port $ShowdownPort or $WebPort is already in use. Run scripts/stop-local.ps1 or choose -ShowdownPort/-WebPort."
}

$bindAddress = if ($ListenLan) { '0.0.0.0' } else { '127.0.0.1' }
$env:POKEMONAI_SHOWDOWN_BIND = $bindAddress
$env:POKEMONAI_SHOWDOWN_PORT = [string]$ShowdownPort
$env:POKEMONAI_SHOWDOWN_LOGS = Join-Path $ProjectRoot 'var\logs\battles'
$env:POKEMONAI_WEB_BIND = $bindAddress
$env:POKEMONAI_WEB_PORT = [string]$WebPort
$env:POKEMONAI_WEB_ROOT = Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com'
$env:POKEMONAI_SHOWDOWN_WS = "ws://127.0.0.1:$ShowdownPort/showdown/websocket"
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config\showdown-config.js') `
    -Destination (Join-Path $ProjectRoot 'vendor\pokemon-showdown\config\config.js') -Force

try {
    New-Item -ItemType Directory -Force -Path $env:POKEMONAI_SHOWDOWN_LOGS | Out-Null
    $showdownArguments = @('pokemon-showdown', 'start', '--skip-build', '--no-security')
    $webArguments = @(
        (Join-Path $ProjectRoot 'services\control-plane\server.py'),
        '--project-root', $ProjectRoot,
        '--bind', $bindAddress,
        '--port', [string]$WebPort,
        '--showdown-port', [string]$ShowdownPort
    )

    Write-Host 'Starting Pokémon Showdown...'
    Start-ManagedProcess -Name 'showdown' -FilePath $NodeExe `
        -ArgumentList $showdownArguments `
        -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') | Out-Null
    Wait-TcpPort '127.0.0.1' $ShowdownPort 60

    Write-Host 'Starting control plane...'
    Start-ManagedProcess -Name 'control-plane' -FilePath $ControlPython `
        -ArgumentList $webArguments `
        -WorkingDirectory $ProjectRoot | Out-Null
    Wait-TcpPort '127.0.0.1' $WebPort 30

    $serviceDefinitions = @(
        @{
            name = 'showdown'; filePath = $NodeExe; arguments = $showdownArguments
            workingDirectory = (Join-Path $ProjectRoot 'vendor\pokemon-showdown')
        },
        @{
            name = 'control-plane'; filePath = $ControlPython; arguments = $webArguments
            workingDirectory = $ProjectRoot
        }
    )
    $supervisorConfig = Join-Path $RuntimeRoot 'supervisor-services.json'
    $serviceDefinitions | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $supervisorConfig -Encoding utf8
    Start-ManagedProcess -Name 'supervisor' -FilePath $ControlPython `
        -ArgumentList @(
            (Join-Path $ProjectRoot 'services\control-plane\supervisor.py'),
            $supervisorConfig, $PidRoot, $LogRoot, $ProjectRoot
        ) -WorkingDirectory $ProjectRoot | Out-Null

    Start-Sleep -Seconds 2
    $failed = @()
    foreach ($name in @('showdown', 'control-plane', 'supervisor')) {
        $servicePid = [int](Get-Content -LiteralPath (Join-Path $PidRoot "$name.pid") -Raw)
        if (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) { $failed += $name }
    }
    if ($failed.Count) { throw "Services exited during startup: $($failed -join ', ')" }

    $url = "http://127.0.0.1:$WebPort/"
    if ($ListenLan) {
        $lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -ExpandProperty IPAddress -First 1
        if ($lanIp) { Write-Host "LAN URL: http://${lanIp}:$WebPort/" -ForegroundColor Cyan }
    }
    Write-Host "Local URL: $url" -ForegroundColor Green
    Write-Host 'Local supervisor is monitoring and will restart failed services.'
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    & (Join-Path $PSScriptRoot 'stop-local.ps1')
    throw
}
