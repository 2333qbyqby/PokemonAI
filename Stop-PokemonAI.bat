@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "POKEMONAI_PWSH="
for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do if not defined POKEMONAI_PWSH set "POKEMONAI_PWSH=%%P"
if not defined POKEMONAI_PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "POKEMONAI_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined POKEMONAI_PWSH set "POKEMONAI_PWSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

"%POKEMONAI_PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local.ps1"
set "POKEMONAI_EXIT=%ERRORLEVEL%"

if "%POKEMONAI_EXIT%"=="0" (
    echo PokemonAI stopped.
) else (
    echo PokemonAI failed to stop. Review the error above.
    pause
)

exit /b %POKEMONAI_EXIT%
