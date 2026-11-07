# 실시간 화면 캡처: headless Edge를 DevTools 프로토콜로 제어한다.
# 사용: . .\cdp.ps1; Start-Cdp; Cdp-Navigate URL; Start-Sleep 6; Cdp-Shot out.png; Stop-Cdp
$script:edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$script:port = 9333
$script:ws = $null
$script:id = 0
$script:proc = $null

function Start-Cdp([int]$Width = 1360, [int]$Height = 1100, [switch]$NoFocus) {
  $profile = Join-Path $env:TEMP "msdash-cdp-profile"
  $script:proc = Start-Process -FilePath $script:edge -PassThru -ArgumentList @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', "--user-data-dir=$profile",
    "--remote-debugging-port=$script:port", "--window-size=$Width,$Height", 'about:blank')
  for ($i = 0; $i -lt 40; $i++) {
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$script:port/json" -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 250 }
  }
  $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(10)
  $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
  Cdp-Call 'Page.enable' @{} | Out-Null
  # headless에서는 잠시 뒤 페이지가 hidden으로 바뀐다. 화면이 보이는 상태로 고정한다.
  if (-not $NoFocus) { Cdp-Call 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } | Out-Null }
}

function Cdp-Call([string]$Method, $Params) {
  $script:id++
  $myId = $script:id
  $json = @{ id = $myId; method = $Method; params = $Params } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $script:ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 1048576
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $r = $script:ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).Result
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
    $msg = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
    if ($msg.id -eq $myId) { return $msg.result }
  }
}

function Cdp-Navigate([string]$Url) { Cdp-Call 'Page.navigate' @{ url = $Url } | Out-Null }

function Cdp-Shot([string]$Out, [switch]$Full) {
  $p = @{ format = 'png' }
  if ($Full) { $p.captureBeyondViewport = $true }
  $res = Cdp-Call 'Page.captureScreenshot' $p
  [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($res.data))
  "saved $Out"
}

function Cdp-Eval([string]$Expr) { (Cdp-Call 'Runtime.evaluate' @{ expression = $Expr; returnByValue = $true }).result.value }

function Stop-Cdp {
  try { $script:ws.Dispose() } catch {}
  if ($script:proc) { Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue }
  Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $script:proc.StartTime } | Stop-Process -Force -ErrorAction SilentlyContinue
}
