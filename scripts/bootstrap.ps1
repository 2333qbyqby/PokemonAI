param(
    [switch]$SkipExpert,
    [switch]$Force
)

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

Write-Host '[1/7] Initializing pinned submodules'
git -C $ProjectRoot submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { throw 'git submodule update failed' }

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

Write-Host '[3/7] Installing project-local uv and Python'
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

Write-Host '[4/7] Creating isolated Python environments'
$baselineVenv = Join-Path $RuntimeRoot 'venvs\baseline-ai'
if ((-not (Test-Path -LiteralPath $BaselinePython)) -or $Force) {
    & $UvExe venv --python $lock.python --clear $baselineVenv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create baseline-ai environment' }
}
& $UvExe pip install --python $BaselinePython -e "$ProjectRoot\services\baseline-ai[test]"
if ($LASTEXITCODE -ne 0) { throw 'Could not install baseline-ai dependencies' }

if (-not $SkipExpert) {
    $foulPlayVenv = Join-Path $RuntimeRoot 'venvs\foul-play'
    if ((-not (Test-Path -LiteralPath $FoulPlayPython)) -or $Force) {
        & $UvExe venv --python $lock.python --clear $foulPlayVenv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create Foul Play environment' }
    }
    & $FoulPlayPython -c 'import poke_engine'
    $hasPokeEngine = $LASTEXITCODE -eq 0
    if (-not $hasPokeEngine) {
        $wheel = Get-ChildItem -Path (Join-Path $ProjectRoot 'artifacts\wheels') -Filter 'poke_engine-0.0.48-*.whl' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wheel) {
            & $UvExe pip install --python $FoulPlayPython $wheel.FullName
        } else {
            Write-Host 'No prebuilt poke-engine wheel found; preparing project-local Rust.'
            $rustupExe = Join-Path $RuntimeRoot 'rustup-init.exe'
            $rustupChecksum = Join-Path $RuntimeRoot 'downloads\rustup-init.exe.sha256'
            Get-RemoteFile $lock.rustup.windowsX64Url $rustupExe
            Get-RemoteFile $lock.rustup.checksumUrl $rustupChecksum
            $rustupExpected = ((Get-Content -LiteralPath $rustupChecksum -Raw).Trim() -split '\s+')[0]
            Assert-Sha256 $rustupExe $rustupExpected
            $env:RUSTUP_HOME = Join-Path $RuntimeRoot 'rustup'
            $env:CARGO_HOME = Join-Path $RuntimeRoot 'cargo'
            $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
            if (-not (Test-Path -LiteralPath (Join-Path $env:CARGO_HOME 'bin\cargo.exe'))) {
                & $rustupExe -y --no-modify-path --profile minimal --default-toolchain $lock.rust
                if ($LASTEXITCODE -ne 0) { throw 'Project-local Rust installation failed' }
            }
            if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
                throw 'Building poke-engine on Windows requires MSVC. Use the prebuilt project Release wheel on machines without it.'
            }
            & $UvExe pip install --python $FoulPlayPython `
                'poke-engine==0.0.48' '--config-settings=build-args=--features poke-engine/terastallization --no-default-features'
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not install poke-engine' }
    }
    & $UvExe pip install --python $FoulPlayPython `
        'requests==2.33.0' 'websockets==14.1' 'python-dateutil==2.8.0' 'PyYAML==6.0.3'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install Foul Play dependencies' }
}

Write-Host '[5/7] Generating client configuration'
& $BaselinePython (Join-Path $ProjectRoot 'scripts\generate-client-config.py') `
    --config (Join-Path $ProjectRoot 'config\agents.yaml') `
    --output (Join-Path $ProjectRoot 'apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts')
if ($LASTEXITCODE -ne 0) { throw 'Client configuration generation failed' }

Write-Host '[6/7] Installing and building Showdown server'
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config\showdown-config.js') `
    -Destination (Join-Path $ProjectRoot 'vendor\pokemon-showdown\config\config.js') -Force
Invoke-LocalNpm -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') ci --ignore-scripts
Invoke-LocalNodeScript -WorkingDirectory (Join-Path $ProjectRoot 'vendor\pokemon-showdown') -Script 'build'

Write-Host '[7/7] Installing and building Showdown client'
Invoke-LocalNpm -WorkingDirectory (Join-Path $ProjectRoot 'apps\showdown-client') ci
Invoke-LocalNodeScript -WorkingDirectory (Join-Path $ProjectRoot 'apps\showdown-client') -Script 'build'

& (Join-Path $PSScriptRoot 'package-source.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Source archive generation failed' }

Write-Host ''
Write-Host 'Bootstrap complete. Run scripts/start-local.ps1.' -ForegroundColor Green
