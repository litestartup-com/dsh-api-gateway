<#
.SYNOPSIS
  Chat with a DeepSeek Harness agent through dsh-api-gateway.

.DESCRIPTION
  Windows-native twin of examples/ask.py: no curl, no jq, no Python — plain
  PowerShell 5.1+ (works in PowerShell 7 too). It claims an API key, creates or
  adopts a session, sends the prompt and prints the reply, streaming token by
  token over SSE unless -NoStream is given.

  Notices (key, session id, adopt mode) go to the error stream and the answer
  goes to the success stream, so `.\ask.ps1 "..." > answer.txt` keeps just the
  answer.

  Exit codes: 0 ok, 1 request/usage error, 2 timeout.

.EXAMPLE
  .\examples\ask.ps1 "介绍一下你自己"

.EXAMPLE
  .\examples\ask.ps1                      # interactive, one session, many turns

.EXAMPLE
  .\examples\ask.ps1 -List                # sessions the gateway can see

.EXAMPLE
  .\examples\ask.ps1 -Session apigw-session-xxx "继续刚才的话题"
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Prompt,
  # Gateway base URL (env DSH_AGW_BASE).
  [string] $Base = $(if ($env:DSH_AGW_BASE) { $env:DSH_AGW_BASE } else { 'http://127.0.0.1:3080/api-gw/v1' }),
  # API key (env DSH_AGW_KEY); claimed via POST /key when unset.
  [string] $Key = $env:DSH_AGW_KEY,
  # Existing session id to adopt (live co-drive or cold resume).
  [string] $Session,
  # Working directory for a new session (decides its workspace).
  [string] $Cwd,
  # LLM provider / model for a new session.
  [string] $Provider,
  [string] $Model,
  # Skip SSE; poll GET /history for the final answer instead.
  [switch] $NoStream,
  # Also print the thinking trace.
  [switch] $Reasoning,
  # Seconds to wait for one turn.
  [int] $Timeout = 300,
  # Answer only: suppress notices.
  [switch] $Quiet,
  # List every session the gateway can see, then exit.
  [switch] $List,
  # Print GET /health (needs no key), then exit.
  [switch] $Health,
  [switch] $Help
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# Notices go to stderr so they never pollute a redirect. PowerShell's `>`
# redirects the success stream, not the console, so streaming deltas (which must
# be written without a trailing newline, i.e. straight to the console) cannot be
# captured: when stdout is redirected we stream to stderr for the human and emit
# the finished answer on the success stream for the pipe.
$Redirected = [Console]::IsOutputRedirected

function Write-Note([string] $Message) {
  if (-not $Quiet) { [Console]::Error.WriteLine($Message) }
}

function Show-Usage {
  @'
ask.ps1 — ask a DeepSeek Harness agent through dsh-api-gateway

  .\ask.ps1 [options] [prompt]      ask once and print the answer
  .\ask.ps1 [options]               interactive: many turns in one session
  .\ask.ps1 -List                   list sessions the gateway can see
  .\ask.ps1 -Health                 gateway status (no key needed)

  -Base <url>       gateway base URL (env DSH_AGW_BASE)
  -Key <key>        API key (env DSH_AGW_KEY); claimed via POST /key when unset
  -Session <id>     talk to an existing session (adopts it first)
  -Cwd <path>       working directory for a new session
  -Provider <id>    LLM provider for a new session
  -Model <id>       model for a new session
  -NoStream         poll GET /history instead of streaming SSE
  -Reasoning        also print the thinking trace
  -Timeout <sec>    per-turn timeout, default 300
  -Quiet            answer only, no notices
  -Help             this text (Get-Help .\ask.ps1 -Full for more)
'@
}

# One JSON round trip. The body is sent as UTF-8 bytes with an explicit charset:
# PowerShell 5.1 would otherwise encode it as ANSI/GBK and mangle CJK prompts.
function Invoke-Gw {
  param([string] $Method, [string] $Path, [hashtable] $Body, [string] $ApiKey)
  $uri = "$Base$Path"
  $headers = @{}
  if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }
  $call = @{ Method = $Method; Uri = $uri; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $Body) {
    $call['ContentType'] = 'application/json; charset=utf-8'
    $call['Body'] = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 6 -Compress))
  }
  try {
    return Invoke-RestMethod @call
  } catch {
    $detail = $_.Exception.Message
    $response = $_.Exception.Response
    if ($response) {
      try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $payload = $reader.ReadToEnd(); $reader.Dispose()
        if ($payload) { $detail = "$([int]$response.StatusCode) $payload" }
      } catch { }
    }
    throw "$Method $uri -> $detail"
  }
}

function Resolve-ApiKey {
  if ($Key) { return $Key }
  $claimed = (Invoke-Gw -Method Post -Path '/key').apiKey
  Write-Note "claimed API key: $claimed"
  Write-Note '  reuse it via $env:DSH_AGW_KEY or -Key (a second claim is refused)'
  return $claimed
}

function Open-Session([string] $ApiKey) {
  if ($Session) {
    $adopted = Invoke-Gw -Method Post -Path "/sessions/$Session/adopt" -ApiKey $ApiKey
    Write-Note "adopted $Session (mode=$($adopted.mode), cwd=$($adopted.cwd))"
    return $Session
  }
  $body = @{}
  if ($Provider) { $body['provider'] = $Provider }
  if ($Model) { $body['model'] = $Model }
  if ($Cwd) { $body['cwd'] = $Cwd }
  $created = Invoke-Gw -Method Post -Path '/sessions' -Body $body -ApiKey $ApiKey
  $workspace = if ($created.workspace) { $created.workspace.title } else { '-' }
  Write-Note "session $($created.sessionId) ($($created.provider)/$($created.model), workspace=$workspace)"
  return $created.sessionId
}

# Attach the stream BEFORE sending the prompt: the server closes a stream at
# `turn_end`, so attaching after the turn finished waits for an event that will
# never arrive. Attaching early is free — the first `hello` frame replays history.
function Invoke-StreamTurn {
  param([string] $ApiKey, [string] $SessionId, [string] $Text)
  Add-Type -AssemblyName System.Net.Http | Out-Null   # PowerShell 5.1 needs this
  $http = [Net.Http.HttpClient]::new()
  $http.Timeout = [TimeSpan]::FromSeconds($Timeout)
  $http.DefaultRequestHeaders.Add('Authorization', "Bearer $ApiKey")
  $http.DefaultRequestHeaders.Add('Accept', 'text/event-stream')
  $reader = $null
  try {
    $stream = $http.GetStreamAsync("$Base/sessions/$SessionId/stream").GetAwaiter().GetResult()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    Invoke-Gw -Method Post -Path "/sessions/$SessionId/messages" -Body @{ content = $Text } -ApiKey $ApiKey | Out-Null
    $answer = ''
    $live = if ($Redirected) { [Console]::Error } else { [Console]::Out }
    while ($null -ne ($line = $reader.ReadLine())) {
      if (-not $line.StartsWith('data: ')) { continue }   # `: ping` heartbeats
      $ev = $line.Substring(6) | ConvertFrom-Json
      switch ($ev.kind) {
        'chunk' {
          if ($ev.chunk.type -eq 'text-delta') {
            $live.Write($ev.chunk.text)
            $answer += $ev.chunk.text
          } elseif ($ev.chunk.type -eq 'reasoning-delta' -and $Reasoning) {
            [Console]::Error.Write($ev.chunk.text)
          }
        }
        'message' { $answer = $ev.text }
        'turn_end' {
          $live.WriteLine()
          if ($ev.reason -ne 'completed') { Write-Note "turn ended: $($ev.reason) $($ev.detail)" }
          if ($Redirected) { Write-Output $answer }
          return
        }
      }
    }
    $live.WriteLine()
    if ($Redirected) { Write-Output $answer }
  } finally {
    if ($reader) { $reader.Dispose() }
    $http.Dispose()
  }
}

function Get-HistoryMessages([string] $ApiKey, [string] $SessionId) {
  $events = (Invoke-Gw -Method Get -Path "/sessions/$SessionId/history" -ApiKey $ApiKey).events
  return @($events | Where-Object { $_.kind -eq 'message' })
}

function Invoke-PollTurn {
  param([string] $ApiKey, [string] $SessionId, [string] $Text)
  # Wrap every call in @(): PowerShell unrolls a one-element array returned from
  # a function into a bare object, and `$object.Count` is $null on 5.1 — so the
  # `-gt` below would silently compare $null and poll until the timeout.
  $seen = @(Get-HistoryMessages $ApiKey $SessionId).Count
  Invoke-Gw -Method Post -Path "/sessions/$SessionId/messages" -Body @{ content = $Text } -ApiKey $ApiKey | Out-Null
  $deadline = (Get-Date).AddSeconds($Timeout)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $messages = @(Get-HistoryMessages $ApiKey $SessionId)
    if ($messages.Count -gt $seen) {
      $reply = $messages[-1]
      if ($Reasoning -and $reply.reasoning) { Write-Note $reply.reasoning }
      Write-Output $reply.text
      return
    }
  }
  throw "no reply within ${Timeout}s"
}

function Invoke-Turn {
  param([string] $ApiKey, [string] $SessionId, [string] $Text)
  if ($NoStream) { Invoke-PollTurn $ApiKey $SessionId $Text } else { Invoke-StreamTurn $ApiKey $SessionId $Text }
}

function Show-Sessions([string] $ApiKey) {
  $sessions = (Invoke-Gw -Method Get -Path '/sessions/discover' -ApiKey $ApiKey).sessions
  if (-not $sessions) { Write-Output '(no sessions)'; return }
  $sessions | ForEach-Object {
    $state = if ($_.live) { 'live' } elseif ($_.persisted) { 'saved' } else { '-' }
    [pscustomobject]@{ sessionId = $_.sessionId; state = $state; title = $_.title; cwd = $_.cwd }
  } | Format-Table -AutoSize
}

try {
  if ($Help) { Show-Usage; exit 0 }
  if ($Health) {
    Invoke-Gw -Method Get -Path '/health' | ConvertTo-Json -Depth 6
    exit 0
  }
  $apiKey = Resolve-ApiKey
  if ($List) { Show-Sessions $apiKey; exit 0 }
  $sessionId = Open-Session $apiKey
  if ($Prompt) {
    Invoke-Turn $apiKey $sessionId ($Prompt -join ' ')
    exit 0
  }
  Write-Note 'interactive mode — empty line or Ctrl-C to quit'
  while ($true) {
    if (-not $Quiet) { [Console]::Error.Write('> ') }
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq '') { exit 0 }
    Invoke-Turn $apiKey $sessionId $line
  }
} catch {
  [Console]::Error.WriteLine("ask.ps1: $($_.Exception.Message)")
  if ("$($_.Exception.Message)" -like 'no reply within*') { exit 2 }
  exit 1
}
