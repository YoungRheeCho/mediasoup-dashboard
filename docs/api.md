# 대시보드 API

사이드카(`server/`)가 제공한다. 인증 없음, 읽기 전용(`POST /api/liveness` 제외). 모든 시각은 수집 서버 시각(UTC ISO 문자열).

## 응답 형식

```jsonc
{
  "meta": {
    "serverId": "edge-tokyo-1", "mode": "edge", "generatedAt": "…",
    "source": "hook",                 // "sim"이면 화면에 SIMULATED 표시
    "collector": { "ok": true, "lastSuccessAt": "…", "ageSeconds": 3, "lastError": null, "skippedCycles": 0 },
    "db": { "writePending": 0, "lastError": null },
    "refresh": { "listSeconds": 10, "detailSeconds": 2 },
    "mockEnabled": true,
    "mockFields": { "viewer_sample.client_fps": "M2", … },   // MOCK 배지 대상
    "originUrl": "http://…"            // edge: 사이드바 "Origin 대시보드 ↗"
  },
  "panels": {
    "<패널>": { "ok": true, "data": …, "excluded": ["w3"], "mock": ["viewer_session.network_type"], "note": "…" }
           | { "ok": false, "error": "…", "reason": "error" | "not_implemented" | "not_found" }
  }
}
```

- 패널마다 따로 성공/실패한다 (UI 상태 4). `excluded`가 있으면 합계에 "w3 제외"를 붙인다.
- `mock`에 있는 값은 서버 코드 수정이 필요해 mock으로 채운 값이다 (`docs/collection-design.md` M1~M8). 화면에 MOCK 배지를 붙인다.
- stale 판단: `meta.collector.ageSeconds` (30초 이상 노랑, 2분 이상 빨강). 수집이 끊겨도 마지막 값은 계속 내려온다.
- loss는 비율(0~1). bitrate는 bps, 시간은 ms.
- `range`: `5m`(10초 간격) · `15m` · `1h`(1분) · `6h`(5분) · `24h`(1시간). 상세 화면은 `session`(접속 전체)도 받는다.

## 공통

| 경로 | 내용 |
|---|---|
| `GET /api/meta` | meta, 알림 규칙, 이 서버 공개 주소 |
| `GET /api/health` | 수집기·DB 기록 상태 |
| `GET /api/alerts` | `firing`(DB 기준 + 현재 값), `near`(경고 임계값 80% 이상, `ratioToWarn`), `history`(24시간, 시간별 횟수), `rules` |

## edge

| 경로 | 패널 |
|---|---|
| `GET /api/edge/overview?range=` | handoff/HANDOFF.md 구성. `status`(배너 등급: 진행 중 알림 심각→crit·경고→warn·수집 실패→warn, 알림 요약, pipe 등급), `flow`(origin 주소, pipe 수신 bps·loss·RTT·등급, 이 edge worker 실행 수·방송 수·송신량/용량, viewer 수·문제 인원), `kpi`(구간 전체 pipe 수신 loss와 알림 등급, worker 실행/전체), `rooms`(방송 행: 수신 중/신호 없음, viewer, bps·loss, 문제 먼저 5개 + `more`), `notes`(worker 재시작·응답 없음, 알림 수, 24시간 이벤트 수). 숫자 임계치는 내보내지 않는다 |
| `GET /api/edge/workers?range=` | `workers`(현재 값 + CPU 추이), `placement`(worker별 router·방송·consumer 수), `advice`, `resources`(CPU user/sys, maxrss, 컨텍스트 스위치/s, 재시작) |
| `GET /api/edge/broadcasts` | `rooms` |
| `GET /api/edge/broadcasts/:roomId?range=1h` | `header`, `flow`(pipe → router → viewers), `producers`(stream별 입력·consumer 수·PLI/분), `viewerSeries`, `layers`(분포, 전환/분과 평소 값) |
| `GET /api/edge/pipe?range=` | `status`(pipe transport, 경로), `series`(loss, 복구 후 loss, RTT, jitter, bitrate), `streams`(stream별 현재 값), `originComparison`(미구현: `not_implemented`) |
| `GET /api/edge/viewers?filter=all\|loss5\|mobile\|lowlayer&room=&q=&sort=loss\|freeze\|rtt\|layer\|connected&limit=` | `viewers`(`counts`: 필터 칩 숫자, `items`) |
| `GET /api/edge/viewers/:viewerId?range=5m\|session` | `session`(+환경), `series`, `timeline`(재생 상태·레이어·연결), `events`, `diagnosis` |
| `GET /api/edge/viewers/:viewerId/live` | 2초 갱신용. 이 viewer의 transport 하나만 훅에 묻는다. 직전 호출과의 차이로 loss·NACK/분·PLI/분 |

`viewerId`는 viewer의 consumer용 WebRtcTransport id다 (peer 이름·기기는 M1 mock).

## origin

| 경로 | 패널 |
|---|---|
| `GET /api/origin/overview` | handoff/HANDOFF.md 구성. `status`(배너 등급, 알림 요약·근접·24시간 건수, ingest 등급, edge 연결 수), `flow`(broadcaster 송출/대기·문제 인원·최대 loss·최대 RTT·입력 bps, origin 직접 viewer 수·문제 인원·시청 bps, origin 송신량/용량, edge별 상태·신호 나이·수신 loss·pipe bps(문제 먼저, 같은 등급은 이름순), edge를 알 수 없는 pipe `unmatchedPipe`), `kpi`(방송 송출/대기, edge 연결/전체, worker 실행/전체), `rooms`(방송 행, 문제 먼저 5개 + `more`) |
| `GET /api/origin/rooms` | `rooms` |
| `GET /api/origin/rooms/:roomId?range=` | `header`, `broadcasters`(+simulcast 레이어 현재 값, 브라우저 보고 M8), `bitrateSeries`, `edges`(송신·수신 측 보고 loss·대시보드 링크), `viewers` |
| `GET /api/origin/broadcasters/:id?range=5m\|1h\|session` | `session`, `series`, `timeline`, `events`, `diagnosis`, `serverValues`, `clientReport`(M8 mock), `delivery` |
| `GET /api/origin/broadcasters/:id/live` | 2초 갱신용 |
| `GET /api/origin/edges` | `summary`, `edges`(문제 있는 것 먼저), `matrix`(방송 × edge: `delivering` / `broken`, 칸이 없으면 "없음") |
| `POST /api/liveness` | edge heartbeat 수신 (push) |

`:id`(broadcaster)는 `<roomId>/<peerId>@<시작 epoch초>` 형식이므로 URL 인코딩해서 넘긴다.

## 통합 3D 화면 (origin)

origin 대시보드의 첫 화면(`/`, `web/central.html`)이 쓴다. edge들이 1초마다 heartbeat에 실어 보내는 실시간 값(`live`)과 origin 수집값을 합친 것이다. DB를 읽지 않는다.

| 경로 | 내용 |
|---|---|
| `GET /api/central/snapshot` | 현재 상태 한 번: `resourceSource`(아래), `origin`(id·노드·송출자 수), `nodes`(노드별 CPU·qdisc drop·edge 목록), `edges`(상태·노드·CPU·worker CPU 합·throttle·시청자 수·수집 1회 시간·건너뛴 주기), `viewers`(시청자 전체: edge·방송·loss(최근 5초)·RTT·레이어·freeze·fps·LATE(MOCK)), `history`(30분, 30초 간격 61칸: 노드 CPU·qdisc, edge CPU·시청자 수), `cluster`(k8s 조회 결과, 켰을 때만), `mockFields` |
| `GET /api/central/stream` | SSE. 1초마다 위와 같은 형식을 보낸다 (이력은 없음) |
| `GET /api/central/history` | 그래프 이력: 30분, 1초 간격 1800칸(마지막 칸 = `endSec`, 값이 없는 초는 `null`). `edges[id]` = `cpu`·`peak`(CPU 최대)·`viewers`·`thrMs`·`egressBps`(시청자 수신 비트레이트 합), `nodes[name]` = `cpu`·`peak`·`drop`·`viewers`(그 노드 edge들의 시청자 합). `?viewer=<id>`를 붙이면 `viewers[id]` = `loss`·`rtt`·`fps`·`layer`·`freezing`·`bitrateBps`. 화면은 처음에 한 번 받고 이후 스냅숏을 이어 붙인다. origin 메모리에만 있다 |

- edge 상태: `connected` / `warning` / `stale`(1초 신호가 5초 이상 없음) / `lost`(edge_signal_age 경고 값, 기본 30초). `lost`인 edge의 시청자는 목록에서 뺀다. 10분 넘게 `lost`인 edge는 이 화면에서 숨긴다.
- MOCK 항목은 [mock-data.md](mock-data.md).
- 자원 값 출처 `resourceSource`:
  - `collector`: Metric-Collector가 한 번이라도 보냈으면 그 값만 쓴다. `edges[].cpuPct` = 컨테이너 CPU(한도 대비, 수집기 pod 이름 = edge id), `edges[].throttledMs/throttledPct`, `nodes[].cpuPct` = 노드 /proc/stat, `nodes[].qdiscDropPerSec`. 수집기가 끊기거나 그 항목이 오래되면 `null`(다른 값으로 바꿔 끼우지 않는다).
  - `sidecar`: 수집기를 붙이지 않은 환경. `edges[].cpuPct` = worker CPU 합, `nodes[].cpuPct` = 사이드카가 잰 /proc/stat, qdisc·throttle은 `null`.
  - `edges[].workerCpuPct`는 출처와 상관없이 worker CPU 합. 이력(`/api/central/history`)의 CPU·drop도 위 값으로 쌓인다.
  - `edges[].cpuPeakPct`·`nodes[].cpuPeakPct` = CPU 최대(그 1초 안의 0.1초 구간 사용률 중 최대). 수집기만 준다. 옛 수집기나 `sidecar`면 `null`.
  - `nodes[].viewerCount` = 그 노드에 있는 edge들의 시청자 수 합.
- `snapshot`의 `sysinfo`: 아래 Metric-Collector 값을 받은 그대로 싣는다 (수집기가 없으면 `seen:false`).

### Metric-Collector 입력 (origin)

수집기(Metric-Collector)가 1초마다 노드·컨테이너 자원 값을 보낸다. 매번 **전체 상태**를 보내고, origin은 마지막 한 번만 메모리에 둔다 (DB 저장 없음).

| 경로 | 내용 |
|---|---|
| `POST /api/central/sysinfo` | 수집기 → origin. 성공 `200 {ok, serverTime, nodes, pods}`, 형식이 틀리면 `400 {error}` |
| `GET /api/central/sysinfo` | 지금 들고 있는 값 (확인용). 아래 "받은 뒤 상태" 형식 |

보내는 형식 (값은 모두 누적 카운터의 **직전 전송 이후 Δ**로 계산한 1초 구간 값):

```json
{
  "t": 1762843945000,
  "nodes": [
    { "name": "edge1", "cpuPct": 34.2, "cpuPeakPct": 61.5, "qdiscDropsPerSec": 0, "ageMs": 300 }
  ],
  "pods": [
    { "name": "mediasoup-edge-7c9f-abcde", "node": "edge1",
      "cpuPct": 62.1, "cpuPeakPct": 88.0, "throttledMs": 0, "throttledPct": 0, "ageMs": 400 }
  ]
}
```

| 필드 | 의미 | 계산 (수집기) |
|---|---|---|
| `t` | 수집기 시각 (unix ms). 참고용 | |
| `nodes[].name` | k8s 노드 이름 | |
| `nodes[].cpuPct` | 노드 CPU 사용률 (%) | 1 − Δidle / Δtotal (`/proc/stat`) |
| `nodes[].cpuPeakPct` | CPU 최대: 그 1초 안의 0.1초 구간 사용률 중 최대 (%). 없으면 생략·`null` | 0.1초 Δidle/Δtotal의 최대 (수집기가 쌓고 1초마다 읽으며 비움) |
| `nodes[].qdiscDropsPerSec` | 물리 NIC root qdisc drop, 1초 동안의 합 | Δdrops (32비트 넘침은 uint32 뺄셈) |
| `pods[].name` | pod 이름. edge의 `MSDASH_SERVER_ID`(= pod 이름)와 같아야 화면에서 맞춰진다 | |
| `pods[].node` | pod가 떠 있는 노드 이름 | |
| `pods[].cpuPct` | 컨테이너 CPU, 한도 대비 (%). 한도가 없으면 `null`. 순간적으로 100을 넘을 수 있다 | Δusage_usec / Δt / limit_cores |
| `pods[].cpuPeakPct` | CPU 최대: 그 1초 안의 0.1초 구간 사용률(한도 대비) 중 최대 (%). 없으면 생략·`null` | 0.1초 Δusage/Δt/limit의 최대 |
| `pods[].throttledMs` | 1초 동안 throttle로 멈춘 시간의 합 (ms) | Δthrottled_usec / 1000 |
| `pods[].throttledPct` | 1초 동안의 CPU 주기 중 throttle된 비율 (%) | Δnr_throttled / Δnr_periods × 100 |
| `*.ageMs` | 수집기가 그 agent에서 마지막으로 값을 받은 뒤 지난 시간 | |

- 계산할 수 없는 값(첫 샘플, 카운터 리셋, 한도 없음)은 `null`로 보낸다. 0과 구분한다.
- 숫자 칸 하나가 이상하면(음수, 문자열, 비율 100 초과) 그 칸만 `null`로 받는다. `nodes`/`pods`가 배열이 아니거나 `name`이 없으면 요청 전체를 400으로 거절한다. 같은 이름이 두 번 오면 뒤의 것을 쓴다.
- 받은 뒤 상태 (`GET`, `snapshot.sysinfo`): `{seen, connected, receivedAt, ageMs, messages, nodes[], pods[]}`. 3초 넘게 POST가 없으면 `connected:false`이고 목록을 비운다. 항목의 `ageMs`가 3초를 넘으면 그 항목은 `stale:true`, 값은 `null`.

```bash
# 확인용으로 직접 보내 보기
curl -X POST http://<origin>:18080/api/central/sysinfo -H 'content-type: application/json' \
  -d '{"nodes":[{"name":"edge1","cpuPct":34.2,"qdiscDropsPerSec":0,"ageMs":300}],"pods":[]}'
curl http://<origin>:18080/api/central/sysinfo
```

## 알려진 한계

- origin의 "대기(송출 없음)" broadcaster: producer가 하나도 없는 peer는 서버 코드 수정 없이는 viewer와 구분할 수 없다. producer가 있다가 bitrate가 0이 된 경우만 대기로 보인다.
- 재시작 횟수·uptime은 사이드카가 켜진 이후 관측분이다.
- NIC 용량은 측정할 수 없어 `MSDASH_NIC_CAPACITY_BPS`(기본 1Gbps)로 받는다. egress는 transport `sendBitrate` 합이다.
