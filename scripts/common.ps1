Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:RuntimeRoot = Join-Path $script:ProjectRoot '.runtime'
$script:NodeRoot = Join-Path $script:RuntimeRoot 'node'
$script:NodeExe = Join-Path $script:NodeRoot 'node.exe'
$script:NpmCmd = Join-Path $script:NodeRoot 'npm.cmd'
$script:UvExe = Join-Path $script:RuntimeRoot 'uv\uv.exe'
$script:BaselinePython = Join-Path $script:RuntimeRoot 'venvs\baseline-ai\Scripts\python.exe'
$script:FoulPlayPython = Join-Path $script:RuntimeRoot 'venvs\foul-play\Scripts\python.exe'
$script:PidRoot = Join-Path $script:RuntimeRoot 'pids'
$script:LogRoot = Join-Path $script:ProjectRoot 'data\process-logs'

function Assert-File([string]$Path, [string]$Message) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Message`nMissing: $Path"
    }
}

function Invoke-LocalNpm {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    Assert-File $script:NpmCmd 'Run scripts/bootstrap.ps1 first.'
    $oldPath = $env:PATH
    $oldCache = $env:npm_config_cache
    try {
        $env:PATH = "$script:NodeRoot;$oldPath"
        $env:npm_config_cache = Join-Path $script:RuntimeRoot 'cache\npm'
        Push-Location $WorkingDirectory
        & $script:NpmCmd @Arguments
        if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
        $env:PATH = $oldPath
        $env:npm_config_cache = $oldCache
    }
}

function Invoke-LocalNodeScript {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    Assert-File $script:NodeExe 'Run scripts/bootstrap.ps1 first.'
    $oldPath = $env:PATH
    try {
        $env:PATH = "$script:NodeRoot;$oldPath"
        Push-Location $WorkingDirectory
        & $script:NodeExe $Script @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Node script failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
        $env:PATH = $oldPath
    }
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 500) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        return $task.Wait($TimeoutMs) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutSeconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TcpPort $HostName $Port) { return }
        Start-Sleep -Milliseconds 300
    }
    throw "Timed out waiting for ${HostName}:$Port"
}

function Start-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    New-Item -ItemType Directory -Force -Path $script:PidRoot, $script:LogRoot | Out-Null
    $pidFile = Join-Path $script:PidRoot "$Name.pid"
    if (Test-Path -LiteralPath $pidFile) {
        $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            throw "$Name is already running with PID $oldPid"
        }
        Remove-Item -LiteralPath $pidFile
    }
    $stdout = Join-Path $script:LogRoot "$Name.stdout.log"
    $stderr = Join-Path $script:LogRoot "$Name.stderr.log"
    # Windows PowerShell joins ArgumentList values without preserving whitespace.
    # Quote the few human-readable arguments (for example "PokemonAI Expert")
    # before handing them to Start-Process.
    $quotedArguments = @($ArgumentList | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    })
    $process = Start-Process -FilePath $FilePath -ArgumentList $quotedArguments `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
    return $process
}
