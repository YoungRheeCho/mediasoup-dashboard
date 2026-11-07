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

## 알려진 한계

- origin의 "대기(송출 없음)" broadcaster: producer가 하나도 없는 peer는 서버 코드 수정 없이는 viewer와 구분할 수 없다. producer가 있다가 bitrate가 0이 된 경우만 대기로 보인다.
- 재시작 횟수·uptime은 사이드카가 켜진 이후 관측분이다.
- NIC 용량은 측정할 수 없어 `MSDASH_NIC_CAPACITY_BPS`(기본 1Gbps)로 받는다. egress는 transport `sendBitrate` 합이다.
