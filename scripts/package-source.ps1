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
        '--exclude=.git' '--exclude=.runtime' '--exclude=data' '--exclude=node_modules' `
        '--exclude=artifacts' '--exclude=pokemonai-source.tar.gz' '.'
    if ($LASTEXITCODE -ne 0) { throw 'tar failed while creating the source archive.' }
} finally {
    Pop-Location
}
Move-Item -LiteralPath $temporaryArchive -Destination $publicArchive -Force
Write-Host "Source archive: $publicArchive"
