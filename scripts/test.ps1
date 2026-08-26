param(
    [switch]$Integration,
    [ValidateRange(1024, 65535)][int]$WebPort = 18080,
    [ValidateRange(1024, 65535)][int]$ShowdownPort = 18000
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-File $ControlPython 'Run scripts/bootstrap.ps1 first.'
Write-Host 'Running control-plane and meta tests...'
& $ControlPython -m pytest `
    (Join-Path $ProjectRoot 'packages\pokemonai-core\tests') `
    (Join-Path $ProjectRoot 'services\control-plane\test_server.py')
if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }

Write-Host 'Building and testing the TypeScript agent...'
Invoke-LocalNpm -WorkingDirectory $ProjectRoot run test:agent

Write-Host 'Rebuilding and validating team library...'
& $ControlPython (Join-Path $ProjectRoot 'scripts\team-library.py') build --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Team library build failed' }

Write-Host 'Regenerating client configuration...'
& $ControlPython (Join-Path $ProjectRoot 'scripts\generate-client-config.py') `
    --config (Join-Path $ProjectRoot 'config\agents.yaml') `
    --output (Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts')
if ($LASTEXITCODE -ne 0) { throw 'Client configuration generation failed' }

$clientRoot = Join-Path $ProjectRoot 'apps\showdown-client'
Write-Host 'Building client...'
$oldPinnedServer = $env:POKEMON_SHOWDOWN_PINNED
try {
    $env:POKEMON_SHOWDOWN_PINNED = '1'
    Invoke-LocalNodeScript -WorkingDirectory $clientRoot -Script 'build'
} finally {
    $env:POKEMON_SHOWDOWN_PINNED = $oldPinnedServer
}
Write-Host 'Transpiling PokémonAI browser modules...'
Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot -Script (Join-Path $ProjectRoot 'scripts\transpile-client.mjs')
Write-Host 'Type-checking client...'
Invoke-LocalNpm -WorkingDirectory $clientRoot -Arguments @('exec', '--', 'tsc')
Write-Host 'Linting client...'
Invoke-LocalNpm -WorkingDirectory $clientRoot -Arguments @(
    'exec', '--', 'eslint', '--cache',
    '--cache-location', 'caches/eslintcache.json', '--max-warnings', '0'
)
Write-Host 'Running client unit tests...'
$clientTests = Get-ChildItem -LiteralPath (Join-Path $clientRoot 'test') -Filter '*.js' |
    Select-Object -ExpandProperty FullName
Invoke-LocalNodeScript -WorkingDirectory $clientRoot -Script '--test' -Arguments $clientTests
if ($Integration) {
    Write-Host 'Running local service smoke test...'
    & (Join-Path $PSScriptRoot 'start-local.ps1') -NoBrowser -WebPort $WebPort -ShowdownPort $ShowdownPort
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/healthz"
        if ($health.status -ne 'ok') { throw 'Web health check failed' }
        if (-not (Test-TcpPort '127.0.0.1' $ShowdownPort)) { throw 'Showdown port is not available' }
        $catalog = $null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/runtime/catalog.json"
            if (-not @($catalog.opponents | Where-Object { $_.availability -ne 'ready' }).Count) { break }
            Start-Sleep -Seconds 1
        }
        $notReady = @($catalog.opponents | Where-Object { $_.availability -ne 'ready' })
        if ($notReady.Count) { throw "Agent runtime is not ready: $($notReady.id -join ', ')" }
        foreach ($opponent in $catalog.opponents) {
            Write-Host "Running battle integration: $($opponent.formatId)..."
            Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot `
                -Script (Join-Path $ProjectRoot 'scripts\run-agent-integration.mjs') `
                -Arguments @(
                    '--project-root', $ProjectRoot,
                    '--format-id', $opponent.formatId,
                    '--opponent-id', $opponent.id,
                    '--opponent', $opponent.username,
                    '--control', "http://127.0.0.1:$WebPort",
                    '--showdown', "ws://127.0.0.1:$ShowdownPort/showdown/websocket"
                )
        }
    } finally {
        & (Join-Path $PSScriptRoot 'stop-local.ps1')
    }
}

Write-Host 'All requested tests passed.' -ForegroundColor Green
