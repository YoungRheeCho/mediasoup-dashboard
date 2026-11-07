$s = Split-Path $MyInvocation.MyCommand.Path
. "$s\cdp.ps1"
function ProxyMode([string]$m) { wsl -d Ubuntu -- bash -c "echo $m > /tmp/uiproxy-mode" }
function State([string]$label) {
  "$label hidden=" + (Cdp-Eval 'document.hidden') + " banner=" + (Cdp-Eval '(document.querySelector(".banner")?.innerText ?? "none").replace(/\n/g," | ")') + " live=" + (Cdp-Eval 'document.querySelector(".live")?.innerText ?? "-"') + " staleDim=" + (Cdp-Eval '!!document.querySelector(".is-stale")')
}

$url = 'http://localhost:18085/overview'
Start-Cdp -Width 1360 -Height 760
try {
  # 1) 연결 불가: 정상으로 띄운 뒤 API 연결을 끊는다
  ProxyMode normal
  Cdp-Navigate $url
  Start-Sleep -Seconds 4
  State 'loaded:'
  ProxyMode down
  Start-Sleep -Seconds 22
  State 'down 22s:'
  Cdp-Shot "$s\st-down.png"

  # 2) 복구: 연결을 되살리고 "지금 다시 시도"
  ProxyMode normal
  Cdp-Eval 'document.querySelector(".banner button")?.click(); "clicked"' | Out-Null
  Start-Sleep -Milliseconds 2500
  State 'after retry:'
  Cdp-Shot "$s\st-recovered.png"

  # 3) 로딩: API가 8초 늦게 응답 (새 페이지)
  ProxyMode slow
  Cdp-Navigate 'http://localhost:18085/workers'
  Start-Sleep -Milliseconds 2000
  Cdp-Shot "$s\st-loading-2s.png"
  Start-Sleep -Milliseconds 4500
  Cdp-Shot "$s\st-loading-6s.png"
  "loading text: " + (Cdp-Eval 'document.querySelector(".skeleton")?.innerText ?? "none"')
} finally {
  ProxyMode normal
  Stop-Cdp
}
