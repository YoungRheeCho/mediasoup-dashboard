$s = Split-Path $MyInvocation.MyCommand.Path
. "$s\cdp.ps1"
function ApiCount { [int](wsl -d Ubuntu -- bash -c "grep -c ' /api/' /tmp/uiproxy.log") }
$setHidden = 'window.__hidden = %V%; Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden }); document.dispatchEvent(new Event("visibilitychange")); "ok"'

Start-Cdp -Width 1360 -Height 760
try {
  Cdp-Navigate 'http://localhost:18085/viewers'
  Start-Sleep -Seconds 4
  $a = ApiCount
  Start-Sleep -Seconds 20
  $b = ApiCount
  "visible: API requests in 20s = $($b - $a)"
  Cdp-Eval ($setHidden -replace '%V%', 'true') | Out-Null
  Start-Sleep -Milliseconds 500
  "hidden: live=" + (Cdp-Eval 'document.querySelector(".live")?.innerText')
  $c = ApiCount
  Start-Sleep -Seconds 25
  $d = ApiCount
  "hidden: API requests in 25s = $($d - $c)"
  Cdp-Eval ($setHidden -replace '%V%', 'false') | Out-Null
  Start-Sleep -Milliseconds 800
  $e = ApiCount
  "returned: API requests within 0.8s = $($e - $d), live=" + (Cdp-Eval 'document.querySelector(".live")?.innerText')
} finally { Stop-Cdp }
