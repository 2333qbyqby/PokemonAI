. (Join-Path $PSScriptRoot 'common.ps1')

$tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarExe) { throw 'Windows tar.exe is required to create the AGPL source archive.' }

$archiveName = 'pokemonai-source.tar.gz'
$temporaryArchive = Join-Path $RuntimeRoot $archiveName
$publicArchive = Join-Path $ProjectRoot "apps\showdown-client\play.pokemonshowdown.com\$archiveName"

if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
Push-Location $ProjectRoot
try {
    & $tarExe.Source -czf $temporaryArchive `
        '--exclude=.git' '--exclude=.runtime' '--exclude=node_modules' `
        '--exclude=__pycache__' '--exclude=*.pyc' '--exclude=.pytest_cache' `
        '--exclude=./data/agents' '--exclude=./data/battles' '--exclude=./data/test-results' `
        '--exclude=./data/team-sources/cache' '--exclude=artifacts' '--exclude=pokemonai-source.tar.gz' '.'
    if ($LASTEXITCODE -ne 0) { throw 'tar failed while creating the source archive.' }
} finally {
    Pop-Location
}
Move-Item -LiteralPath $temporaryArchive -Destination $publicArchive -Force
Write-Host "Source archive: $publicArchive"
