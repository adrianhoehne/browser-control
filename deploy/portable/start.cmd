@echo off
setlocal EnableDelayedExpansion
rem Portable start: create the token on the first run, print the three lines the
rem guides refer to, and start the bridge. Nothing is installed and nothing is
rem written outside this folder. No WSL, no service, no PID file: this console
rem owns the bridge, and Ctrl+C ends it.

set "BIN=%~dp0browser-control-bridge.exe"
set "DATA=%~dp0data"
set "TOKEN_FILE=%DATA%\token"

if not exist "%BIN%" (
  echo error: the bridge is missing: %BIN% 1>&2
  exit /b 1
)

if not exist "%DATA%" mkdir "%DATA%"

rem The token is written once and never replaced: a new one on every start would
rem log the extension out each time. The value comes from a cryptographic random
rem number generator, not from the shell's own random source.
rem GetBytes(32) is the static form of .NET 5 and later; Create() is the fallback
rem for the Windows PowerShell 5.1 that ships with Windows.
if not exist "%TOKEN_FILE%" (
  powershell -NoProfile -Command "try { $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32) } catch { $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $bytes = New-Object byte[] 32; $rng.GetBytes($bytes) }; [IO.File]::WriteAllText('%TOKEN_FILE%', (-join ($bytes | ForEach-Object { $_.ToString('x2') })))"
  if errorlevel 1 (
    echo error: could not write the token file %TOKEN_FILE% 1>&2
    exit /b 1
  )
)

rem Windows has no chmod. The token inherits the ACL of this folder, which belongs
rem to the user who unzipped it — the reason the folder must not be moved into a
rem shared location.

set "BC_TOKEN_FILE=%TOKEN_FILE%"

rem BC_BIND and BC_HTTP_PORT are passed through unchanged; the defaults below are
rem the bridge's own. The loop splits BC_BIND at the last colon, because an IPv6
rem literal carries colons of its own.
set "BIND_HOST=127.0.0.1"
set "BIND_PORT=8110"
if not defined BC_BIND goto bind_done
set "REST=!BC_BIND!"
set "PORT="
:split_bind
if "!REST!"=="" goto bind_done
if "!REST:~-1!"==":" goto bind_port_found
set "PORT=!REST:~-1!!PORT!"
set "REST=!REST:~0,-1!"
goto split_bind
:bind_port_found
set "REST=!REST:~0,-1!"
if not "!REST!"=="" set "BIND_HOST=!REST!"
if not "!PORT!"=="" set "BIND_PORT=!PORT!"
:bind_done

rem A wildcard address is not an address anybody can type into the extension, so
rem it is printed as loopback: what cannot be dialled must not be shown.
if "!BIND_HOST!"=="0.0.0.0" set "BIND_HOST=127.0.0.1"
if "!BIND_HOST!"=="::" set "BIND_HOST=127.0.0.1"
if "!BIND_HOST!"=="[::]" set "BIND_HOST=127.0.0.1"

if not defined BC_HTTP_PORT set "BC_HTTP_PORT=8111"

rem A non-numeric port would be replaced by the bridge's default without a word, so
rem it is replaced here too: the printed value has to be the value that applies.
for /f "delims=0123456789" %%p in ("!BIND_PORT!") do set "BIND_PORT=8110"
for /f "delims=0123456789" %%p in ("!BC_HTTP_PORT!") do set "BC_HTTP_PORT=8111"

set /p PRINTED_TOKEN=<"%TOKEN_FILE%"
echo endpoint: ws://!BIND_HOST!:!BIND_PORT!
echo http: http://127.0.0.1:!BC_HTTP_PORT!/mcp
echo token: !PRINTED_TOKEN!

"%BIN%" --http
exit /b %ERRORLEVEL%
