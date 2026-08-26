param([switch]$Force)

. (Join-Path $PSScriptRoot 'common.ps1')

function Get-RemoteFile([string]$Url, [string]$Destination) {
    if ((Test-Path -LiteralPath $Destination) -and -not $Force) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Write-Host "Downloading $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Assert-Sha256([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual"
    }
}

$lock = Get-Content -LiteralPath (Join-Path $ProjectRoot 'config\runtime-lock.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $RuntimeRoot, (Join-Path $RuntimeRoot 'downloads'), (Join-Path $RuntimeRoot 'cache') | Out-Null

Write-Host '[1/7] Initializing pinned Showdown source'
if (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git')) {
    git -C $ProjectRoot submodule update --init vendor/pokemon-showdown
    if ($LASTEXITCODE -ne 0) { throw 'git submodule update failed' }
}

Write-Host '[2/7] Installing project-local Node.js'
$nodeZip = Join-Path $RuntimeRoot "downloads\node-v$($lock.node.version)-win-x64.zip"
$nodeSums = Join-Path $RuntimeRoot "downloads\node-v$($lock.node.version)-SHASUMS256.txt"
Get-RemoteFile $lock.node.windowsX64Url $nodeZip
Get-RemoteFile $lock.node.checksumsUrl $nodeSums
$nodeFileName = Split-Path -Leaf $nodeZip
$nodeExpected = ((Get-Content -LiteralPath $nodeSums) | Where-Object { $_ -match "\s+$([regex]::Escape($nodeFileName))$" } | Select-Object -First 1).Split(' ')[0]
if (-not $nodeExpected) { throw "Node checksum not found for $nodeFileName" }
Assert-Sha256 $nodeZip $nodeExpected
if ((-not (Test-Path -LiteralPath $NodeExe)) -or $Force) {
    $extractRoot = Join-Path $RuntimeRoot 'node-extract'
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    if (Test-Path -LiteralPath $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $extractRoot
    $expandedNode = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    Move-Item -LiteralPath $expandedNode.FullName -Destination $NodeRoot
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

Write-Host '[3/7] Installing project-local Python'
$uvZip = Join-Path $RuntimeRoot "downloads\uv-$($lock.uv.version)-windows-x64.zip"
$uvChecksum = Join-Path $RuntimeRoot "downloads\uv-$($lock.uv.version)-windows-x64.zip.sha256"
Get-RemoteFile $lock.uv.windowsX64Url $uvZip
Get-RemoteFile $lock.uv.checksumUrl $uvChecksum
$uvExpected = ((Get-Content -LiteralPath $uvChecksum -Raw).Trim() -split '\s+')[0]
Assert-Sha256 $uvZip $uvExpected
$uvRoot = Join-Path $RuntimeRoot 'uv'
if ((-not (Test-Path -LiteralPath $UvExe)) -or $Force) {
    if (Test-Path -LiteralPath $uvRoot) { Remove-Item -LiteralPath $uvRoot -Recurse -Force }
    Expand-Archive -LiteralPath $uvZip -DestinationPath $uvRoot
}
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot 'cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot 'python'
& $UvExe python install $lock.python
if ($LASTEXITCODE -ne 0) { throw 'uv python install failed' }

Write-Host '[4/7] Creating control-plane environment'
$controlVenv = Join-Path $RuntimeRoot 'venvs\control-plane'
if ((-not (Test-Path -LiteralPath $ControlPython)) -or $Force) {
    & $UvExe venv --python $lock.python --clear $controlVenv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create control-plane environment' }
}
& $UvExe pip install --python $ControlPython -e "$ProjectRoot\packages\pokemonai-core"
if ($LASTEXITCODE -ne 0) { throw 'Could not install control-plane dependencies' }

Write-Host '[5/7] Building the agent and Showdown'
& $ControlPython (Join-Path $ProjectRoot 'scripts\ensure-upstreams.py') --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Pinned upstream repair failed' }
Invoke-LocalNpm -WorkingDirectory $ProjectRoot ci
Invoke-LocalNpm -WorkingDirectory $ProjectRoot run build:agent
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config\showdown-config.js') -Destination (Join-Path $ProjectRoot 'vendor\pokemon-showdown\config\config.js') -Force
Invoke-LocalNpm -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') ci --ignore-scripts
Invoke-LocalNodeScript -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') -Script 'build'

Write-Host '[6/7] Generating formats and team library'
& $ControlPython (Join-Path $ProjectRoot 'scripts\generate-client-config.py') --config (Join-Path $ProjectRoot 'config\agents.yaml') --output (Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts')
if ($LASTEXITCODE -ne 0) { throw 'Client configuration generation failed' }
& $ControlPython (Join-Path $ProjectRoot 'scripts\team-library.py') build --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Team library build failed' }

Write-Host '[7/7] Building Showdown client'
Invoke-LocalNpm -WorkingDirectory (Join-Path $ProjectRoot 'apps\showdown-client') ci
$clientCacheRoot = Join-Path $ProjectRoot 'apps\showdown-client\caches'
$clientServerCache = Join-Path $clientCacheRoot 'pokemon-showdown'
New-Item -ItemType Directory -Force -Path $clientCacheRoot | Out-Null
if (-not (Test-Path -LiteralPath $clientServerCache)) {
    New-Item -ItemType Junction -Path $clientServerCache -Target (Join-Path $ProjectRoot 'vendor\pokemon-showdown') | Out-Null
}
$oldPinnedServer = $env:POKEMON_SHOWDOWN_PINNED
try {
    $env:POKEMON_SHOWDOWN_PINNED = '1'
    Invoke-LocalNodeScript -WorkingDirectory (Join-Path $ProjectRoot 'apps\showdown-client') -Script 'build' -Arguments @('full')
} finally {
    $env:POKEMON_SHOWDOWN_PINNED = $oldPinnedServer
}
Invoke-LocalNodeScript -WorkingDirectory $ProjectRoot -Script (Join-Path $ProjectRoot 'scripts\transpile-client.mjs')
& (Join-Path $PSScriptRoot 'package-source.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Source archive generation failed' }

Write-Host ''
Write-Host 'Bootstrap complete. Run scripts/start-local.ps1.' -ForegroundColor Green
