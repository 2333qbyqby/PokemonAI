param(
    [switch]$ListenLan,
    [switch]$NoBrowser,
    [switch]$SkipExpert,
    [ValidateRange(1024, 65535)][int]$WebPort = 8080,
    [ValidateRange(1024, 65535)][int]$ShowdownPort = 8000
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-File $NodeExe 'Run scripts/bootstrap.ps1 first.'
Assert-File $BaselinePython 'Run scripts/bootstrap.ps1 first.'
if (-not $SkipExpert) { Assert-File $FoulPlayPython 'Run scripts/bootstrap.ps1 first, or pass -SkipExpert.' }

if ((Test-TcpPort '127.0.0.1' $ShowdownPort) -or (Test-TcpPort '127.0.0.1' $WebPort)) {
    throw "Port $ShowdownPort or $WebPort is already in use. Run scripts/stop-local.ps1 or choose -ShowdownPort/-WebPort."
}

$bindAddress = if ($ListenLan) { '0.0.0.0' } else { '127.0.0.1' }
$env:POKEMONAI_SHOWDOWN_BIND = $bindAddress
$env:POKEMONAI_SHOWDOWN_PORT = [string]$ShowdownPort
$env:POKEMONAI_SHOWDOWN_LOGS = Join-Path $ProjectRoot 'data\battles'
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
    $baselineArguments = @(
        '-m', 'baseline_ai.runner',
        '--config', (Join-Path $ProjectRoot 'config\agents.yaml'),
        '--data-dir', (Join-Path $ProjectRoot 'data\agents\baseline')
    )
    $expertArguments = @()
    if (-not $SkipExpert) {
        $expertRegistryArguments = @(
            (Join-Path $ProjectRoot 'services\expert-ai\runner.py'),
            '--config', (Join-Path $ProjectRoot 'config\agents.yaml'),
            '--foul-play-root', (Join-Path $ProjectRoot 'vendor\foul-play'),
            '--data-dir', (Join-Path $ProjectRoot 'data\agents\foul-play'),
            '--print-command'
        )
        $expertCommandJson = & $FoulPlayPython @expertRegistryArguments
        if ($LASTEXITCODE -ne 0) { throw 'Could not resolve Foul Play arguments from config/agents.yaml' }
        $expertCommand = @($expertCommandJson | ConvertFrom-Json)
        $expertArguments = @($expertCommand | Select-Object -Skip 1)
    }
    $webArguments = @((Join-Path $ProjectRoot 'services\web-server\server.mjs'))

    Write-Host 'Starting Pokémon Showdown...'
    Start-ManagedProcess -Name 'showdown' -FilePath $NodeExe `
        -ArgumentList $showdownArguments `
        -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') | Out-Null
    Wait-TcpPort '127.0.0.1' $ShowdownPort 60

    Write-Host 'Starting baseline AI opponents...'
    Start-ManagedProcess -Name 'baseline-ai' -FilePath $BaselinePython `
        -ArgumentList $baselineArguments -WorkingDirectory $ProjectRoot | Out-Null

    if (-not $SkipExpert) {
        Write-Host 'Starting Foul Play expert opponent...'
        New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'data\agents\foul-play') | Out-Null
        Start-ManagedProcess -Name 'expert-ai' -FilePath $FoulPlayPython `
            -ArgumentList $expertArguments `
            -WorkingDirectory (Join-Path $ProjectRoot 'data\agents\foul-play') | Out-Null
    }

    Write-Host 'Starting client web server...'
    Start-ManagedProcess -Name 'web' -FilePath $NodeExe `
        -ArgumentList $webArguments `
        -WorkingDirectory $ProjectRoot | Out-Null
    Wait-TcpPort '127.0.0.1' $WebPort 30

    Start-Sleep -Seconds 2
    $failed = @()
    foreach ($name in @('showdown', 'baseline-ai', 'web')) {
        $servicePid = [int](Get-Content -LiteralPath (Join-Path $PidRoot "$name.pid") -Raw)
        if (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) { $failed += $name }
    }
    if (-not $SkipExpert) {
        $servicePid = [int](Get-Content -LiteralPath (Join-Path $PidRoot 'expert-ai.pid') -Raw)
        if (-not (Get-Process -Id $servicePid -ErrorAction SilentlyContinue)) { $failed += 'expert-ai' }
    }
    if ($failed.Count) { throw "Services exited during startup: $($failed -join ', ')" }

    $serviceDefinitions = @(
        @{
            name = 'showdown'; filePath = $NodeExe; arguments = $showdownArguments
            workingDirectory = (Join-Path $ProjectRoot 'vendor\pokemon-showdown')
        },
        @{
            name = 'baseline-ai'; filePath = $BaselinePython; arguments = $baselineArguments
            workingDirectory = $ProjectRoot
        },
        @{
            name = 'web'; filePath = $NodeExe; arguments = $webArguments
            workingDirectory = $ProjectRoot
        }
    )
    if (-not $SkipExpert) {
        $serviceDefinitions += @{
            name = 'expert-ai'; filePath = $FoulPlayPython; arguments = $expertArguments
            workingDirectory = (Join-Path $ProjectRoot 'data\agents\foul-play')
        }
    }
    $supervisorConfig = Join-Path $RuntimeRoot 'supervisor-services.json'
    $serviceDefinitions | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $supervisorConfig -Encoding utf8
    Start-ManagedProcess -Name 'supervisor' -FilePath $NodeExe `
        -ArgumentList @(
            (Join-Path $ProjectRoot 'services\supervisor\supervisor.mjs'),
            $supervisorConfig, $PidRoot, $LogRoot
        ) -WorkingDirectory $ProjectRoot | Out-Null

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
