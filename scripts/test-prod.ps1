. (Join-Path $PSScriptRoot 'common.ps1')

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    throw 'Docker is required for production validation. Run this script on the VPS or a Docker workstation.'
}

$oldValues = @{
    PUBLIC_HOST = $env:PUBLIC_HOST
    ACME_EMAIL = $env:ACME_EMAIL
    BASIC_AUTH_USER = $env:BASIC_AUTH_USER
    BASIC_AUTH_HASH = $env:BASIC_AUTH_HASH
}
try {
    $env:PUBLIC_HOST = 'pokemonai.example.test'
    $env:ACME_EMAIL = 'test@example.test'
    $env:BASIC_AUTH_USER = 'test'
    $env:BASIC_AUTH_HASH = '$2a$14$wM8M7Q5P1H6ERXaQ6tYwueXIZV2qU3XH1ePXzcXfEwYxYkYemvSPm'

    & $docker.Source compose -f (Join-Path $ProjectRoot 'compose.prod.yml') config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration is invalid.' }

    & $docker.Source compose -f (Join-Path $ProjectRoot 'compose.prod.yml') `
        run --rm --no-deps --build --entrypoint caddy web `
        validate --config /etc/caddy/Caddyfile --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration is invalid.' }
} finally {
    $env:PUBLIC_HOST = $oldValues.PUBLIC_HOST
    $env:ACME_EMAIL = $oldValues.ACME_EMAIL
    $env:BASIC_AUTH_USER = $oldValues.BASIC_AUTH_USER
    $env:BASIC_AUTH_HASH = $oldValues.BASIC_AUTH_HASH
}

Write-Host 'Production Compose and Caddy configurations are valid.' -ForegroundColor Green
