param(
    [switch]$Integration,
    [ValidateRange(1024, 65535)][int]$WebPort = 18080,
    [ValidateRange(1024, 65535)][int]$ShowdownPort = 18000
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-File $BaselinePython 'Run scripts/bootstrap.ps1 first.'
Write-Host 'Running configuration and baseline tests...'
& $BaselinePython -m pytest (Join-Path $ProjectRoot 'services\baseline-ai\tests')
if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }

Write-Host 'Rebuilding and validating team library...'
& $BaselinePython (Join-Path $ProjectRoot 'scripts\team-library.py') build --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Team library build failed' }

Write-Host 'Regenerating client configuration...'
& $BaselinePython (Join-Path $ProjectRoot 'scripts\generate-client-config.py') `
    --config (Join-Path $ProjectRoot 'config\agents.yaml') `
    --output (Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts')
if ($LASTEXITCODE -ne 0) { throw 'Client configuration generation failed' }

$clientRoot = Join-Path $ProjectRoot 'apps\showdown-client'
Write-Host 'Building client...'
Invoke-LocalNodeScript -WorkingDirectory $clientRoot -Script 'build'
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
Write-Host 'Running local web server tests...'
Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot -Script '--test' -Arguments @(
    (Join-Path $ProjectRoot 'services\web-server\server.test.mjs')
)

if ($Integration) {
    Write-Host 'Running local service smoke test...'
    & (Join-Path $PSScriptRoot 'start-local.ps1') -NoBrowser -WebPort $WebPort -ShowdownPort $ShowdownPort
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/healthz"
        if ($health.status -ne 'ok') { throw 'Web health check failed' }
        if (-not (Test-TcpPort '127.0.0.1' $ShowdownPort)) { throw 'Showdown port is not available' }
        & $BaselinePython (Join-Path $PSScriptRoot 'run-bot-integration.py') `
            --config (Join-Path $ProjectRoot 'config\agents.yaml') `
            --websocket-url "ws://127.0.0.1:$ShowdownPort/showdown/websocket" `
            --output (Join-Path $ProjectRoot 'data\test-results\bot-integration.json')
        if ($LASTEXITCODE -ne 0) { throw 'Bot integration battles failed' }
    } finally {
        & (Join-Path $PSScriptRoot 'stop-local.ps1')
    }
}

Write-Host 'All requested tests passed.' -ForegroundColor Green
