. (Join-Path $PSScriptRoot 'common.ps1')

Assert-File $ControlPython 'Run scripts/bootstrap.ps1 first.'

Write-Host 'Building the TypeScript agent...'
Invoke-LocalNpm -WorkingDirectory $ProjectRoot run build:agent

Write-Host 'Rebuilding the team library...'
& $ControlPython (Join-Path $ProjectRoot 'scripts\team-library.py') build --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Team library build failed' }

Write-Host 'Regenerating client configuration...'
& $ControlPython (Join-Path $ProjectRoot 'scripts\generate-client-config.py') `
    --config (Join-Path $ProjectRoot 'config\agents.yaml') `
    --output (Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts')
if ($LASTEXITCODE -ne 0) { throw 'Client configuration generation failed' }

$clientRoot = Join-Path $ProjectRoot 'apps\showdown-client'
Write-Host 'Building the client...'
$oldPinnedServer = $env:POKEMON_SHOWDOWN_PINNED
try {
    $env:POKEMON_SHOWDOWN_PINNED = '1'
    Invoke-LocalNodeScript -WorkingDirectory $clientRoot -Script 'build'
} finally {
    $env:POKEMON_SHOWDOWN_PINNED = $oldPinnedServer
}

Write-Host 'Transpiling PokémonAI browser modules...'
Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot -Script (Join-Path $ProjectRoot 'scripts\transpile-client.mjs')

Write-Host 'Type-checking the client...'
Invoke-LocalNpm -WorkingDirectory $clientRoot -Arguments @('exec', '--', 'tsc')

Write-Host 'Build completed.' -ForegroundColor Green
