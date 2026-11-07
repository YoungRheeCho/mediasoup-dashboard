# mediasoup 모니터링 대시보드 — 구현 정리 · 미구현 항목 · 수정 가이드

작성: 2026-10-20. 이 문서 하나로 "무엇이 어떻게 만들어졌고, 무엇이 비어 있고, 무엇을 정해야 하며, 어디를 고치면 되는지"를 알 수 있게 쓴다.
세부 문서: [api.md](api.md) (API 명세), [collection-design.md](collection-design.md) (수집 설계·훅 고려 사항 H1~H14·mock M1~M11·검증 기록),
[ui-states.md](ui-states.md) (UI 상태 점검), [deploy.md](deploy.md) (배포), 원 지시서 [../AGENT_TASK.md](../AGENT_TASK.md).

---

## 목차

1. [한눈에 보기](#1-한눈에-보기)
2. [미구현 · 임시(mock) · 한계 목록](#2-미구현--임시mock--한계-목록)
3. [정해야 하는 것](#3-정해야-하는-것)
4. [전체 구조와 데이터 흐름](#4-전체-구조와-데이터-흐름)
5. [구성 요소별 구현 상세](#5-구성-요소별-구현-상세)
6. [지표 정의 (숫자가 어떻게 계산되는가)](#6-지표-정의)
7. [DB 스키마](#7-db-스키마)
8. [설정 (환경 변수) 전체](#8-설정-환경-변수-전체)
9. [수정 가이드 (자주 할 작업)](#9-수정-가이드)
10. [개발 · 시험 방법](#10-개발--시험-방법)
11. [현재 배포 상태와 운영](#11-현재-배포-상태와-운영)
12. [검증 이력 요약](#12-검증-이력-요약)

---

## 1. 한눈에 보기

- **원칙:** mediasoup 쪽 코드(`qos/network/mediasoup-demo`, `qos/network/mediasoup`)와 원본 매니페스트는 **수정하지 않는다.**
  서버 코드를 고쳐야만 얻을 수 있는 값은 **mock**으로 채우고 화면에 `◇ MOCK` 배지를 붙인다. mock 값은 알림 평가에 쓰지 않는다.
- **구조:** 서버(origin·edge)마다 같은 Pod 안에 세 가지를 둔다.
  1. **훅** (`hook/msdash-hook.cjs`) — mediasoup 서버 프로세스에 `NODE_OPTIONS=--require`로 사전 로드. 읽기 전용으로 mediasoup 객체를 추적하고 `getStats()`를 대신 불러 유닉스 소켓으로 돌려준다.
  2. **사이드카** (`server/` + `web/`, 이미지 `mediasoup-dashboard`) — 수집·정규화·DB 기록·알림·heartbeat·API·화면.
  3. **TimescaleDB** — 서버마다 로컬 DB 하나. 중앙 DB 없음.
- **기술:** Node 22 + TypeScript(사이드카), React 18.3.1 + Vite 6.2.1(화면, 기존 `app/`과 같은 버전), TimescaleDB 2.17.2(pg16). 사이드카 의존성은 `pg` 하나.
- **상태:** AGENT_TASK 10절의 7단계 모두 구현·검증. 실제 클러스터(`mediasoup-edge-0`, `mediasoup-origin`)에 올려 `source: hook`, `collector.ok: true` 확인됨.

### 디렉터리

```
mediasoup-dashboard/
├─ AGENT_TASK.md              원 지시서
├─ Dockerfile, .dockerignore  사이드카 이미지 (server + web 빌드)
├─ hook/msdash-hook.cjs       mediasoup 서버에 사전 로드되는 훅 (의존성 없음)
├─ db/                        스키마·시드 SQL (사이드카가 시작할 때 자동 적용)
│   ├─ edge_schema.sql, edge_seed.sql
│   └─ origin_schema.sql, origin_seed.sql
├─ server/                    사이드카 (TypeScript)
│   ├─ src/
│   │   ├─ index.ts           진입점: 구성 요소 연결
│   │   ├─ config.ts          환경 변수
│   │   ├─ hookProtocol.ts    훅 응답 형식 (원시 mediasoup stats)
│   │   ├─ sources/           mediasoup 입력: hookSource(실제) / simSource(개발용 시뮬레이터)
│   │   ├─ collector/         수집 루프, delta, 정규화(edge/origin), 객체 관계 색인
│   │   ├─ mock/              서버 수정이 필요한 값의 mock (M1~M8)
│   │   ├─ db/                DB 접근 계층: rows(행 타입), store(인터페이스), timescale/(구현), writer(기록 큐)
│   │   ├─ alerts/            알림 지표·평가기·sink
│   │   ├─ liveness/          edge→origin heartbeat (push 기본, pull 교체 가능)
│   │   ├─ api/               화면별 API, 현재 값 계산(live), 진단 문구(diagnose)
│   │   └─ http/              작은 JSON 라우터, 정적 파일(화면) 서빙
│   ├─ test/                  단위 테스트 (node:test)
│   └─ scripts/               api-smoke.mjs(모든 API 점검), read-smoke.mjs(DB 읽기 점검)
├─ web/                       화면 (React)
│   └─ src/{App.tsx, lib/, components/, pages/edge/, pages/origin/, pages/Alerts.tsx, styles.css}
├─ deploy/k8s/{edge,origin}/  원본 매니페스트를 참조하는 kustomize overlay (참고용, 11절 참고)
├─ tools/                     시험 도구 (실제 mediasoup 훅 하네스, UI 상태 시험)
└─ docs/
```

---

## 2. 미구현 · 임시(mock) · 한계 목록

표기: **[MOCK]** 화면에는 나오지만 가짜 값 · **[미구현]** 화면·기능 없음 · **[한계]** 구현했지만 제약이 있음 · **[미확인]** 실제 환경에서 검증 안 됨.
M 번호는 [collection-design.md](collection-design.md) 4절과 같다. mock 목록은 코드의 `server/src/mock/index.ts`의 `MOCK_FIELDS`에 있다.

### 2.1 mock (서버·클라이언트 코드 수정이 필요해서)

| # | 항목 | 화면 위치 | 왜 실제 값을 못 얻나 | 실제로 바꾸려면 (최소 변경) |
|---|---|---|---|---|
| M1 | viewer의 peerId·이름·기기 종류(mobile/desktop) | Viewers 목록 이름, "모바일" 필터, viewer 상세 | consumer의 `appData.peerId`에는 **broadcaster** id가 들어 있고, "어느 transport가 어느 viewer(peer)인가"는 `Peer.#transports`(private)에만 있다. 그래서 지금은 **viewer = consumer용 WebRtcTransport 하나**로 보고 transport id를 viewer id로 쓴다(지표는 실제). | mediasoup-demo `Peer.ts`에서 transport를 만들 때 `appData`에 `peerId` 추가(한 줄). 훅의 `describeTransport`가 지금은 `appData.direction`만 넘기므로 `peerId`도 넘기게 한 줄 추가하고, 사이드카에서 `room.serialize()`의 peers와 조인한다 (9.2절). **단, 이걸로 얻는 건 이름과 브라우저 종류·버전뿐이다.** 클라이언트(`app/src/deviceInfo.js`)는 브라우저 정보(`flag/name/version`)만 보내고 모바일/PC 구분은 보내지 않으므로, 기기 종류는 M4(user agent 저장)도 함께 고쳐야 한다. |
| M2 | 브라우저 보고값: freeze 횟수·시간, 디코딩 fps, jitter buffer, dropped frames, 재생 상태, 수신 해상도 | viewer 상세 KPI·차트·"브라우저가 보고한 값", 목록 Freeze 열, 진단 "재생 끊김" | **구현됨 (2026-10-23, mediasoup-demo `fec-merged` `57835fe`).** 클라이언트가 5초마다 `notify('reportClientStats')`(누적 freezeCount·freezeSec·framesDropped + fps·jitter buffer·해상도), 서버 `Peer.ts`가 consumer transport `appData.clientStats`에 넣고 훅이 읽는다. 사이드카는 누적값 차이로 구간 값을 만들고 `client_reported=true`로 저장. 보고한 적 없는 viewer(옛 클라이언트)만 mock이고 그때만 배지가 붙는다. 보고가 15초 넘게 끊기면 mock이 아니라 빈 값. | Safari·Firefox는 `freezeCount`가 없어 freeze가 "—". 한 방에 영상 producer가 여럿이면 하나의 값만 보고된다(클라이언트 `_lastClientReportAt` 공용). |
| M3 | 네트워크 종류(wifi/lte/wired), downlink 추정 | **화면에서 숨김 (2026-10-22).** 전에는 목록 "환경" 열, Overview "접속 환경별 loss p50", 진단 "모바일 네트워크"에 있었다. mock 값으로 묶은 통계가 잘못 읽힐 수 있어서 API 응답과 화면에서 뺐다(DB 컬럼·mock 생성은 그대로). 구현하면 `edgeRoutes.ts`의 `viewerRow`·`qualityDistribution`과 화면을 되살린다. | 브라우저 `navigator.connection`에만 있고, 지금 클라이언트는 이 값을 읽지도 않는다. | M2 보고에 같이 담는다. 단 `navigator.connection`은 Chrome 계열만 지원하고 Safari(iOS 포함)·Firefox에는 없어서, 고쳐도 일부 viewer만 값이 나온다. |
| M4 | user agent 원문(브라우저/OS 문구) | viewer 상세 헤더·접속 환경 | 서버가 WS 헤더를 저장하지 않고 bowser 파싱 결과(`device.flag/name/version`)만 남긴다. | `WsServer`에서 `req.headers['user-agent']`를 Peer로 넘겨 `serialize()`에 포함. |
| M5 | 접속 종료 사유 | `viewer_session.disconnect_reason` (화면 직접 표시 없음) | Peer가 닫힐 때 사유를 내보내지 않는다. 마지막 transport 상태가 failed면 `transport_failed`는 실제로 판단하고, 나머지는 mock. | `Peer`의 `closed` 이벤트에 사유를 담는다. |
| M8 | broadcaster 인코더 fps, 해상도, 품질 제한 사유, 가용 송신 대역폭, 인코더·카메라·마이크 정보 | origin Rooms 카드 fps, Broadcaster 상세 KPI·"브라우저가 보고한 값" | mediasoup producer stats에 fps 항목이 없다(포크 소스에서 확인). 나머지는 송출 브라우저만 안다. | broadcaster 클라이언트가 outbound-rtp(`framesPerSecond`, `qualityLimitationReason` 등)를 M2와 같은 방식으로 보고. |

mock 값은 **id에서 결정적으로** 만든다(같은 viewer는 늘 같은 기기·이름). `MSDASH_MOCK=0`이면 mock 컬럼은 모두 NULL("—")이 된다.

### 2.2 미구현

| 항목 | 상태 | 이유 / 결정 필요 |
|---|---|---|
| Pipe 화면 "Origin 측 값과 비교" 패널 (M10) | 패널 자리에 "○ 구현하지 않은 항목" 표시 (API `not_implemented`) | `design/README.md`가 "미정이므로 구현하지 말고 보고"로 지정. edge는 자기 데이터만 갖는다. → 3절 Q3 |
| origin 사이드바의 Workers · Viewers 화면 | 메뉴 없음 | AGENT_TASK 6.2에서 "이번 범위에서는 만들지 않는다(미정)". origin의 Alerts는 edge와 같은 화면으로 있다. → 3절 Q5 |
| 알림 확인(acknowledge) 버튼, 외부 알림(Slack·웹훅) | 없음 | 지시서·시안 README에서 범위 밖. 외부 알림은 `AlertSink` 인터페이스로 훅 자리만 열어 둠(9.5절). |
| 알림 규칙 UI 수정 | 읽기 전용 | 지시서: 시드로 넣고 UI에서 수정하지 않는다. 바꾸려면 DB `alert_rule`을 직접 수정(9.4절). |
| 인증·권한 | 없음 | 지시서 범위 밖. 대시보드 포트(18080)는 네트워크로 막아야 한다. `POST /api/liveness`는 DB에 쓴다. |
| origin "대기(송출 없음)" broadcaster 중 **producer가 한 번도 없었던 사람** | 표시 안 됨 | producer가 없는 peer는 서버 코드 수정 없이는 viewer와 구분 불가. producer가 있다가 bitrate 0이 된 경우만 "대기"로 보인다. M1과 같은 수정으로 해결. |
| 이벤트 목록의 "router 생성" 같은 서버 내부 이벤트 | 일부만 | 지금 이벤트 = 알림 이력 + 방송 처음 수신(edge)/송출 시작(origin) + viewer·broadcaster 상세의 레이어 변화·연결 상태 변화(샘플에서 추론). router 생성 이벤트는 저장하지 않는다. |

### 2.3 한계 (구현은 했지만)

| 항목 | 내용 |
|---|---|
| viewer loss의 의미 (M9) | 서버가 아는 viewer 구간 loss는 viewer가 보낸 **RTCP RR** 뿐이다. 브라우저는 RTX로 복구된 패킷을 받은 것으로 세므로 **복구 후 loss에 가깝다.** 복구 전 원본 loss는 서버에서 얻을 수 없다. → 지시서 4.4의 "기본=원본 loss"와 다르다. 3절 Q2. |
| edge pipe 수신 loss | pipe는 원래 seq 번호를 그대로 전달하므로 **broadcaster→origin 구간 유실도 섞인다.** 툴팁에 명시. origin의 broadcaster loss와 비교해서 봐야 한다. |
| 수신 RTT | pipe·broadcaster 수신 측 RTT는 mediasoup 설정에 따라 0(측정 안 됨)일 수 있고, 0은 NULL로 표시한다. 실제 하네스에서 pipe RTT는 값이 나왔다. |
| origin viewer loss | origin 스키마에 viewer 테이블이 없어 저장하지 않고 **현재 값만** 계산(O1 분포, O2 p50). 추이 없음. |
| worker 재시작 횟수·uptime | 사이드카가 켜진 이후 관측분만 (`WorkerTracker`). |
| NIC 용량·egress | 용량은 측정 불가 → 설정값(`MSDASH_NIC_CAPACITY_BPS`). egress는 transport `sendBitrate` 합(NIC 실측 아님). |
| 레이어 표시 | spatial layer 2 이상=High, 1=Mid, 0=Low로 고정 매핑. simulcast 레이어 수가 다르면 이름이 어긋날 수 있다. |
| 같은 worker의 producer id | 같은 worker 안에서 producer id는 유일해야 한다(mediasoup 규칙). 실제 배포(origin·edge 별도 서버)에서는 문제없다. |
| 재시작 직후 | 누적값 기준점이 없어 첫 수집 구간은 "값 없음"(차트 선 한 칸 끊김). 의도된 동작(지시서 4.2-2). |
| 한글 글꼴 | IBM Plex에는 한글 글리프가 없어 한글은 시스템 글꼴. 필요하면 `@fontsource/ibm-plex-sans-kr` 추가. |
| 1분 집계 | continuous aggregate는 1분 간격·1분 지연으로 갱신. 2시간 넘는 구간 + 1분 이상 bucket에서만 집계를 읽는다(`useAggregate`). |
| viewer loss p50/p95 추이 | 백분위는 집계에서 만들 수 없어 원본(viewer 48시간 보관)에서만 계산한다. 48시간보다 긴 구간은 없다. |
| 화면 갱신 시점 | 화면 폴링이 수집 시점과 맞춰져 있지 않아 최대 10초 지난 값을 보여 줄 수 있다. **2.6절.** |
| **수집 부하 (순간 몰림·viewer 비례)** | 10초마다 모든 객체에 getStats를 몰아서 호출하고 큰 JSON을 한 번에 만든다. viewer당 호출 3번(transport 1 + consumer 2)으로 총량이 viewer 수에 비례한다. 실제 규모에서는 측정하지 않았다. **2.5절.** |

### 2.4 실제 환경에서 확인 안 된 것

- **실제 브라우저 viewer(DTLS 연결) 구간:** viewer RR 기반 loss·RTT·NACK/PLI 값. 하네스의 viewer transport는 연결되지 않은 상태라 값이 비었다. 실제 클러스터에서 방송·시청을 해 보고 Viewer 상세 "서버가 본 값"을 확인 필요.
- **포크 mediasoup(3.19.14 기반) 자체로 훅 시험:** npm의 mediasoup 3.19.14로 시험했다. 클러스터에서 `source: hook`, `collector.ok: true`는 확인됨.
- **휴대폰 너비(390px) 화면:** headless 브라우저 최소 폭(492px) 때문에 미확인. 600px은 정상.
- **장시간 운영:** 메모리 누수, DB 용량, 압축 정책 동작. viewer 300명 기준 viewer_sample은 이틀 약 5백만 행(압축됨).

### 2.5 수집 부하 한계와 개선안 (보류)

현재 동작과 한계, 상의한 개선 방향을 기록한다. **아직 고치지 않았다.** 결정은 3절 Q12.

**현재 동작**

- 사이드카가 10초마다 `snapshot`을 한 번 요청하면, 훅이 **살아 있는 모든 객체**에 호출한다.
  - worker: `getResourceUsage()`
  - transport·producer·consumer: `getStats()`
  - router: 호출 없음
- 상세 화면을 연 viewer는 2초마다 `transportDetail`로 그 transport와 consumer만 추가 호출한다.
- 동시 6개 제한과 호출당 2초 타임아웃이 있고, 직전 수집이 안 끝났으면 이번 사이클은 건너뛴다(`collectSkipped`).
- API와 화면은 캐시를 읽으므로, 화면 수는 호출 수에 영향이 없다.

**한계 A: 순간 몰림.** 실제 문제가 될 가능성이 더 큰 쪽이다.

- 동시 6개는 "한 번에 6개까지"일 뿐 속도 제한이 아니다. 전체 호출이 연달아 실행되어 10초 중 짧은 구간에 몰리고, 나머지는 논다. 10초 평균 지표에는 잘 안 보이고 **10초마다 튀는** 형태로만 드러난다.
- 영향받는 곳:
  - **Node 이벤트 루프:** mediasoup 서버의 signaling과 같은 스레드다. 마지막의 snapshot 조립과 `JSON.stringify`는 끊을 수 없는 동기 작업이라, viewer가 많으면 이벤트 루프를 통째로 막을 수 있다.
  - **worker:** RTP 처리와 같은 루프에서 통계 요청을 처리한다. 동시 6개 제한이 worker별이 아니라 전체 합계라서 한 worker에 몰릴 수 있고, 몰리면 jitter나 지연이 튈 수 있다.
  - **사이드카:** 정규화, DB 쓰기, 알림 판정을 수집 직후에 몰아서 한다. CPU limit이 없으면 노드 CPU를 순간적으로 쓴다.

**한계 B: 총량이 viewer 수에 비례한다.**

| viewer | 10초당 호출 | 초당 평균 |
|---|---|---|
| 100 | ~300 | ~30 |
| 500 | ~1,500 | ~150 |
| 2,000 | ~6,000 | ~600 |

- 미디어 처리량도 viewer 수에 비례하므로, 그에 비한 비율은 비슷하게 유지된다.
- 다만 Node 단일 스레드에서 처리되는 몫(요청, 응답 해석, JSON)과 snapshot 응답 크기도 함께 커진다.

**확인 방법 (지금 가능).** 대시보드 수집기 상태에서 아래를 보면 된다.

- `collectDurationMs`
- 이벤트 루프 지연 p99: 수집 때마다 튀는지
- worker CPU: 방송이 없을 때와 비교

**개선안 (상의 결과).** 모두 훅과 사이드카만 고치면 되고, mediasoup 코드는 그대로 둔다.

1. **먼저 측정한다.**
   - 하네스로 viewer 100, 500, 1000명에 해당하는 객체 수에서 기준선을 잡는다.
   - 잴 것: 수집 시간, 이벤트 루프 지연 최대치, worker 패킷 지연 튐.
2. **A 해결: 일정 관리를 사이드카로 옮긴다.**
   - 훅 method를 둘로 나눈다.
     - `list`: 객체 목록과 속성만. getStats 없음.
     - `stats {ids}`: 지정한 몇 개만 getStats.
   - 사이드카가 10초에 걸쳐 잘게 나눠 요청한다(페이싱). 응답이 쪼개지므로 큰 JSON 문제도 함께 없어진다.
   - 훅에는 안전 상한으로 **worker별 동시 1개**를 둔다.
   - 훅은 오히려 단순해지고, 주기와 우선순위를 바꿀 때 ConfigMap을 다시 배포하지 않아도 된다.
   - 대안은 훅 안에서 페이싱하는 것이다. 프로토콜 변경은 적지만 훅이 복잡해지고 큰 JSON 문제가 남는다.
3. **같이 바꿀 것: delta 기준 시각.**
   - 지금은 모든 객체를 같은 순간에 찍었다고 보고 사이클 간격으로 계산한다.
   - 페이싱이나 순환을 하면 객체별 실제 측정 시각(getStats `timestamp`)으로 간격을 계산해야 한다.
   - 개수 기반 비율(손실률)은 영향이 없다.
4. **B가 필요하면: 계층별 주기.**

   | 대상 | 주기 |
   |---|---|
   | worker, pipe 수신, 방송 producer | 10초 |
   | viewer | 순환, viewer당 20~30초 |
   | 상세 화면을 연 viewer | 2초 (지금과 같음) |
   | 접속·종료·연결 실패 | 10초마다 `list` (호출 비용 없음) |

   - 영향:
     - viewer 목록과 이력의 해상도가 20~30초가 된다.
     - viewer 단위 알림의 반응이 느려진다(window 조정 필요).
   - 별도로 **음성 consumer 생략**을 쓸 수 있다. viewer당 호출이 3번에서 2번으로 준다.

**참고: 다른 모니터링 도구의 일반적인 해법**

| 해법 | 예 | 우리 적용 |
|---|---|---|
| 평소에 카운터를 쌓고 수집 때는 읽기만 | Prometheus 클라이언트 라이브러리 | mediasoup 수정이 필요해서 불가 |
| 비싼 수집은 백그라운드에서, 요청엔 캐시 | exporter, `scrape_timeout`, `sample_limit` | 이미 적용 |
| 시작 시점 분산과 페이싱 | Prometheus의 대상별 offset, Telegraf `collection_jitter`/`flush_jitter` | 개선안 2 |
| 개별 단위는 집계하거나 드물게 수집 | Prometheus의 높은 cardinality 회피, 샘플링 | 개선안 4 |

### 2.6 개선 목록 (보류)

상의해서 정한 개선 항목이다. 아직 고치지 않았다.

| 항목 | 지금 | 문제 | 개선 방법 |
|---|---|---|---|
| 수집 부하 | 2.5절 | 2.5절 | 2.5절 |
| **화면 갱신 시점을 수집 직후로 맞추기** | 사이드카는 10초마다 수집해서 캐시에 넣는다. 화면은 이와 무관하게 10초마다 캐시를 읽는다(목록 화면). | 둘의 시점이 엇갈리면 화면은 최대 10초 지난 값을 보여 준다. 예: 수집 0·10·20초, 화면 9·19·29초 → 거의 10초 전 값. 지금은 30초 넘게 안 바뀔 때 "오래됨" 표시만 한다. | API 응답에 마지막 수집 시각(또는 다음 수집 예정 시각)을 담고, 화면은 다음 요청을 **"다음 수집 시각 + 1초쯤"**에 보낸다. 수집 시간이 길어질 때를 위해, 받은 값이 이전과 같으면 1~2초 뒤 한 번 더 요청한다. 고칠 곳: 사이드카 API 응답(`server/src/api/`), 화면 폴링(`web/src/lib/usePolling.ts`). 2초 갱신인 viewer 상세는 훅에 직접 묻기 때문에 해당 없음. |

### 2.7 화면 데이터를 얻는 방법별로 나누기

현재 화면에서 쓰는 데이터를 **"얻으려면 무엇을 고쳐야 하나"** 기준으로 나눴다. 2.1절의 mock 표와 같은 내용을 수정 범위 기준으로 다시 묶은 것이다. 코드 위치는 edge(deadline 브랜치) 기준이다.

| 구분 | 고칠 곳 | 해당 mock |
|---|---|---|
| 1. 그대로 사용 | 없음 | — |
| 2. 클라이언트가 서버로 보내기 | 클라이언트 + 서버 + 훅 | M2, M3, M8 |
| 3. transport에 peerId 넣기 | 서버 1줄 + 훅 1줄 | M1 |
| 4. 서버만 수정 | 서버 + 훅 | M4, M5 (모바일 구분은 M1도 필요) |
| 5. 고쳐도 근사값만 | — | M9, NIC 용량 |

적은 수정으로 효과가 큰 순서: **3 → 4 → 2.**

**1. 그대로 사용 (코드 수정 없음, 지금 실제 값)**

RTCP 보고(브라우저가 표준에 따라 자동으로 보내는 수신 보고)와 서버가 직접 재는 값이다.

| 화면 | 데이터 |
|---|---|
| viewer 목록·상세 | 손실 수·손실률 (RTCP), RTT (RTCP), NACK 횟수 (RTCP), 재전송 패킷 수, 비트레이트, 현재 화질 layer, ICE·DTLS 연결 상태, 접속·종료 시각 |
| Pipe (edge) | 받은·유실·복구된 패킷, 복구 전/후 손실률, 비트레이트, RTT, jitter, NACK, PLI |
| 방송자 (origin) | 수신 비트레이트, 손실률, jitter, NACK·PLI, 화질 layer |
| Workers | CPU, 메모리, router·transport·consumer 수 |
| 수집기 상태 | 수집 시간, 이벤트 루프 지연, Node 메모리, 호스트 CPU |
| 방·연결 | 방별 viewer 수, 들어오고 나가는 비트레이트, edge 연결 상태(heartbeat) |

이 값들은 **네트워크 전달**까지만 보여 준다. 영상이 화면에서 실제로 끊겼는지는 직접 보이지 않는다. 대신 PLI 증가, layer 하락, 비트레이트 급감 같은 간접 신호로 볼 수 있다.

**2. 클라이언트가 서버로 보내야 하는 것**

브라우저만 아는 값이다. 고칠 곳은 셋이다.

1. 클라이언트: 5~10초마다 protoo `notify('clientStats', {...})`로 보낸다.
2. 서버 `Peer.ts`: `handleProtooNotification`에 받는 경우를 추가하고 이벤트로 내보낸다.
3. 훅: 그 이벤트를 받아 snapshot에 담는다.

클라이언트가 통계를 **consumer id 기준으로** 정리하므로, 3번(peerId) 없이도 viewer에 정확히 이어 붙일 수 있다.

| mock | 데이터 | 비고 |
|---|---|---|
| M2 | 디코딩 fps, dropped frames, jitter buffer 지연, 받은 해상도 | `app/src/RoomClient.edge.js`의 `startVideoStatsMonitor`가 이미 1초마다 계산한다(Redux와 console로만 보냄). 보내기만 추가하면 된다. |
| M2 | freeze 횟수·시간, 재생 상태 | 클라이언트에 계산 로직도 추가해야 한다. freeze(`freezeCount`, `totalFreezesDuration`)는 브라우저마다 지원이 다르다. |
| M3 | 네트워크 종류(wifi/LTE), downlink 추정 | `navigator.connection`은 Chrome 계열만 지원한다. 아이폰(Safari)과 Firefox는 빈칸이 된다. |
| M8 | 방송자 인코더 fps, 해상도, 품질 제한 사유, 송신 대역폭, 카메라·마이크 정보 | 방송자 클라이언트를 고친다. mediasoup producer 통계에는 fps가 없다. |

권장 방식 (상의 결과):

- 지금은 서버가 아는 값(1번)만 쓴다.
- 클라이언트 보고를 넣게 되면 두 단계로 나눈다.
  - 핵심 몇 개(freeze, fps, 해상도)는 10초마다 항상 보낸다.
  - 전체 항목을 1초 단위로 보내는 건 상세 화면을 볼 때만 켠다.
- "필요할 때만 켜기"를 처음부터 넣지 않는 이유:
  - 대시보드 → 서버 → 브라우저로 켜기·끄기 명령을 전달하는 길이 새로 필요하다.
  - 훅이 "읽기만 한다"는 원칙이 깨진다.
  - 10초에 메시지 1개 정도는 서버 부담이 거의 없어서 아낄 것도 적다.
- 브라우저가 대시보드(18080)로 직접 보내는 방법은 클라이언트만 고치면 되지만, 인증 없는 대시보드를 인터넷에 열어야 해서 권하지 않는다.

**3. transport에 peerId를 넣으면 mock이 필요 없어지는 것 (M1)**

정보는 이미 서버에 있다(`room.serialize()`의 peers). 다만 "어느 transport가 어느 peer인가"가 `Peer`의 private 필드에만 있어서 이어 붙이지 못한다. consumer의 `appData.peerId`는 viewer가 아니라 방송자 id라 쓸 수 없다.

고칠 곳:

- 서버 (edge·origin 두 브랜치):
  - `server/src/types.ts`의 `WebRtcTransportAppData`에 `peerId?: string`을 추가한다.
  - `Peer.ts`의 `case 'createWebRtcTransport'`에서 `this.#transports.set(...)` 다음에 `transport.appData.peerId = this.#peerId;`를 넣는다.
- 훅 `describeTransport`: `peerId: safeGet(() => transport.appData && transport.appData.peerId) ?? null,`를 넣는다(1줄).
- 사이드카 (edge): **반영 완료 (2026-10-21).**
  - `hookProtocol.ts`: `RawTransport.peerId`
  - `normalizeEdge.ts`: `#sessionStart`가 `raw.rooms`의 peer를 찾아 채우고, 못 찾으면 mock으로 채운다. 처음에 못 찾은 viewer는 매 주기 다시 찾고, 찾으면 신원 칸만 갱신한다.
  - `db/edge_schema.sql`: `viewer_session`에 `identity_source`, `browser_name`, `browser_version`, `remote_ip` 컬럼을 추가했다. 이미 만든 DB에는 `edge_seed.sql`의 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`가 시작할 때 컬럼을 보탠다.
  - `edgeStore.ts`: insert가 upsert로 바뀌었다. 실제 신원(`'peer'`)일 때만 갱신하고, 실제 값을 mock으로 덮지 않는다.
  - `mock/index.ts`: `device_class`를 M4로 옮겼다(peer 정보에 없음).
  - `api/edgeRoutes.ts`: viewer 응답에 `peerId`, `identitySource`, `browser`, `remoteIp`를 추가했다. 목록 패널은 mock 신원이 섞였을 때만 이름 MOCK 배지를 단다. 상세의 브라우저는 실제 신원이면 peer 정보에서 가져온다.
  - 서버 코드와 훅이 바뀌기 전에는 지금처럼 mock으로 동작한다. 그래서 순서와 상관없이 배포할 수 있다.
  - origin 쪽(대기 중 방송자 판별)은 아직 반영하지 않았다.

| 데이터 | 비고 |
|---|---|
| peerId, 표시 이름 | |
| 브라우저 종류·이름·버전 | 접속할 때 클라이언트가 이미 보낸다(`app/src/deviceInfo.js`). 모바일/PC 구분은 들어 있지 않다 → 4번 |
| 접속 IP | |
| 같은 사람의 재접속 묶기 (일부) | 지금은 재접속하면 새 transport가 생겨 다른 viewer로 보이고, 이력이 쪼개진다. 단 클라이언트가 peerId를 **페이지를 열 때마다 새로 만든다**(`app/src/index.jsx`의 `randomString`). 그래서 같은 페이지 안의 재연결만 묶이고, 새로고침하면 다른 사람이 된다. 완전히 묶으려면 클라이언트가 peerId를 저장해서 다시 써야 한다. |
| origin "대기 중" 방송자 (송출을 한 번도 안 한 사람) | 지금은 viewer와 구분할 수 없다(2.2절). |

peer의 접속 IP와 transport의 상대 IP를 비교해 맞춰 보는 방법은 넣지 않았다. 같은 공유기 뒤의 사용자, 프록시, 모바일 네트워크 때문에 다른 사람과 이어 붙일 수 있어서다.

**4. 서버 코드만 고치면 되는 것 (클라이언트 수정 없음)**

| mock | 데이터 | 고칠 곳 | 비고 |
|---|---|---|---|
| M4 | user agent 원문 | `WsServer`가 이미 받는 `user-agent` 헤더를 Peer에 저장하고 `serialize()`에 포함 | |
| M1 + M4 | 모바일 / PC 구분 | user agent로 판단 | 3번과 4번을 **둘 다** 고쳐야 viewer에 붙는다. 중요도가 낮아 **Viewers의 "모바일" 필터를 뺐다 (2026-10-22).** |
| M5 | 접속 종료 사유 | 아래 4개 경로에서 사유를 함께 내보내고(예: `emit('disconnected', 'ice_disconnected')`) 훅이 받는다 | 지금은 마지막 transport 상태가 `failed`인 경우만 `transport_failed`로 실제 판단하고, 나머지는 mock이다. |

M5에 서버 수정만 필요한 이유는, 서버가 끊김을 이미 경로별로 따로 감지하기 때문이다. 다만 사유를 담지 않고 `close()` + `emit('disconnected')`만 한다.

| `Peer.ts` 위치 | 언제 | 사유 이름 (예) |
|---|---|---|
| `handleProtooPeer`: protoo `close` | 웹소켓 연결이 끊김 | `ws_closed` |
| `icestatechange`: `disconnected`/`closed` | 미디어 연결이 끊김 (네트워크) | `ice_disconnected` |
| `dtlsstatechange`: `failed`/`closed` | 암호화 연결 실패 | `dtls_failed` |
| 생성자의 `joinTimer` | 접속만 하고 방에 들어오지 않음 | `join_timeout` |

한계가 하나 있다. `ws_closed`에는 "탭 닫음", "페이지 이동", "네트워크 끊김으로 웹소켓도 끊김"이 섞인다.

- 웹소켓 종료 코드로 일부를 가를 수 있는지는 확인이 필요하다.
- 확실히 구분하려면 클라이언트가 나갈 때 "나간다"는 메시지를 보내야 한다. 이건 2번 범주다.

**5. 고쳐도 정확히는 못 얻는 것**

| 데이터 | 이유 | 지금 처리 |
|---|---|---|
| viewer 구간 복구 전 손실률 (M9) | RTCP 보고는 재전송으로 복구된 패킷을 받은 것으로 센다. | 복구 후 손실률에 가깝다고 툴팁에 명시했다. 복구 전 값은 NACK로 근사한다. pipe와 방송자 수신 쪽은 서버가 직접 받으므로 정확하다. |
| NIC 용량 | 측정할 방법이 없다. | 설정값(`MSDASH_NIC_CAPACITY_BPS`) |

**정할 것: mock 칸 처리.** 서버 값만 쓰기로 하면, 지금 mock으로 채운 칸(freeze, fps, 네트워크 종류, "브라우저가 보고한 값" 패널 등)의 처리 방법을 정해야 한다(3절 Q13).

- (a) 칸을 숨긴다.
- (b) 칸은 두고 "—"와 "클라이언트 보고 필요" 표시를 한다. `MSDASH_MOCK=0`이 거의 이렇게 동작한다.
- (c) 지금처럼 mock과 MOCK 배지를 둔다.

---

## 3. 정해야 하는 것

| Q | 질문 | 선택지 | 현재 상태 / 권장 |
|---|---|---|---|
| Q1 | 서버·클라이언트 코드 수정을 허용할지 | (a) 계속 금지 (b) 최소 수정 허용 | 지금 (a). (b)면 M1·M2·M3·M4·M5·M8을 2.1절의 "최소 변경"대로 바꾸고 mock 제거. **M1(transport appData에 peerId) 한 줄이 효과가 가장 크다.** 장기적으로는 서버에 공식 관측 지점(`Server.observer`에 peer 이벤트)을 두면 훅이 단순해진다(M11). |
| Q2 | loss 정의 (M9) | (a) 기본 = RR 기반 loss(복구 후에 가까움), 원본은 NACK 기반 근사 (b) 지시서대로 원본 | 지금 (a)로 구현·툴팁 명시. 지시서 4.4 수정 필요. pipe·broadcaster(수신 측)는 원본·복구 후 둘 다 실제 값. |
| Q3 | Pipe 화면의 origin 송신 값 비교 (M10) | (a) 안 만든다 (b) heartbeat **응답**에 origin의 그 edge 송신 통계를 담아 돌려준다 (c) edge가 origin API를 조회 | 지금 (a). 만든다면 (b) 권장: push 구조 유지, origin에 이미 `pipe_send_sample`이 있다. |
| Q4 | heartbeat 방식 | push / pull | push로 구현, `MSDASH_LIVENESS_MODE=pull`로 교체 가능(양쪽 같게). 확정 필요. |
| Q5 | origin Workers·Viewers 화면 | 만든다 / 안 만든다 | 만든다면 edge 화면 재사용: Workers는 거의 그대로, Viewers는 origin `viewer_sample` 테이블과 정규화 추가가 필요(지금 origin은 viewer를 저장하지 않음). |
| Q6 | 보관 기간 | viewer 원본 48시간 / 원본 7일 / 집계 14일 (기본) | 설정으로 바꿀 수 있음(8절). 실제 용량을 보고 확정. |
| Q7 | 알림 임계값 | 시드값(아래) | 제가 정한 시작값. 운영하며 조정. 7.3절 표. |
| Q8 | 대시보드 접근 제한 | 방화벽 / 내부망 / 인증 추가 | 지금 인증 없음. 최소한 18080을 내부망으로 제한. |
| Q9 | 배포 방식 | 직접 수정한 Pod/Deployment yaml / kustomize overlay | 실제로는 사용 중인 yaml에 직접 넣었다(11절). overlay는 저장소의 원본 yaml 기준이라 실제 매니페스트와 다르다. 하나로 정리 필요. |
| Q10 | DB 저장 위치 | hostPath / PVC | 지금 hostPath(`/var/lib/msdash/...`). Pod가 다른 노드로 옮겨지면 이력이 따라가지 않는다. |
| Q11 | 휴대폰·좁은 화면 지원 수준 | | 600px까지 확인. 실제 기기 확인 필요. |
| Q12 | 수집 부하 개선 (2.5절) | (a) 그대로 (b) A만: 사이드카 주도 페이싱 (c) A + B: 계층별 주기, 음성 생략 | 지금 (a), 한계로 기록. 범위를 정하려면 **edge 1대당 최대 viewer 수**와 **viewer 데이터 신선도 요구(10초 / 20~30초)**가 필요하다. 그 밖에 viewer 단위 알림 필요 여부, 음성 통계 필요 여부. 고치기 전에 측정 먼저 권장. |
| Q13 | mock 칸 처리 (2.7절) | (a) 숨김 (b) "—" + "클라이언트 보고 필요" 표시 (c) 지금처럼 mock + 배지 | 지금 (c). 운영용이면 (a)나 (b) 권장. 서버 값(2.7절 1번)만 쓰는 방향으로 상의됨. **모바일/PC 구분(M4)과 네트워크 종류(M3)는 (a) 숨김으로 정함 (2026-10-22).** 브라우저는 실제 값(peer 정보)이라 남기고, 신원이 mock인 viewer에만 배지를 붙인다. 나머지(freeze·fps 등 M2)는 아직 (c). |

---

## 4. 전체 구조와 데이터 흐름

```
┌──────────────────────────── 같은 Pod (origin 또는 edge) ─────────────────────────────┐
│                                                                                        │
│  mediasoup-server 컨테이너 (원본 이미지, 코드 그대로)                                   │
│  ┌──────────────────────────────────────────────────────┐                              │
│  │ node (npm start)                                      │                              │
│  │  ├ [사전 로드] msdash-hook.cjs  ← ConfigMap 마운트     │                              │
│  │  │   mediasoup.observer 구독 → 객체 추적 (읽기 전용)   │                              │
│  │  │   요청 시 getStats()/getResourceUsage()            │                              │
│  │  │   유닉스 소켓 /var/run/msdash/hook.sock ───────────┼──┐  (emptyDir 공유)          │
│  │  └ mediasoup-demo 서버 (Server/Room/Peer, worker들)   │  │                           │
│  └──────────────────────────────────────────────────────┘  │                           │
│                                                              │                           │
│  msdash 컨테이너 (사이드카, 포트 18080)                      ▼                           │
│  ┌──────────────────────────────────────────────────────────────────────┐              │
│  │ Collector (10초) ── HookSource.snapshot() ──► Normalizer(edge|origin)│              │
│  │      │                                            │                    │              │
│  │      │      메모리 캐시: latest batch + raw 스냅숏 2개                  │              │
│  │      ├──► BatchWriter ──► TimescaleStore.saveBatch() ──► msdash-db    │              │
│  │      ├──► AlertEvaluator (서버 값만) ──► alert_event + AlertSink      │              │
│  │      ├──► (edge) EdgeLivenessSource ── PushReporter ── POST ──────────┼─► origin     │
│  │      └──► API (DB 추이 + 캐시 현재 값) ──► 화면(web/dist 정적 서빙)    │   /api/liveness
│  └──────────────────────────────────────────────────────────────────────┘              │
│                                                                                        │
│  msdash-db 컨테이너 (TimescaleDB, 127.0.0.1:55432, hostPath에 데이터)                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**주기와 호출 규칙 (AGENT_TASK 4.3, 3-8)**

- 10초마다 Collector가 훅에 `snapshot`을 **한 번** 요청 → 전체 stats. 화면·알림·DB가 같은 결과를 쓴다. 화면 요청은 mediasoup을 부르지 않는다.
- 수집이 끝나기 전에 다음 주기가 오면 건너뛰고 경고·카운트(`collect_skipped`).
- 상세 화면(viewer/broadcaster)은 열려 있는 동안 2초마다 `/live` → 훅에 `transportDetail`(transport 하나와 그 consumer/producer만). 같은 transport 요청은 1초 동안 재사용.
- 화면은 10초(목록)/2초(상세) polling, 탭이 숨으면 멈추고 돌아오면 즉시 1회.

---

## 5. 구성 요소별 구현 상세

### 5.1 훅 — `hook/msdash-hook.cjs`

**무엇:** mediasoup 서버 프로세스 안에서 도는 작은 CommonJS 파일. 의존성 없음(Node 내장 모듈만).

**동작 순서**

1. **대상 프로세스 확인 (H2):** `NODE_OPTIONS`는 npm·npx 같은 하위 Node 프로세스에도 상속된다. `process.argv[1]`의 파일 이름이 `MSDASH_HOOK_MATCH`(기본 `mediasoup-demo-server`)일 때만 켠다. 아니면 아무것도 하지 않는다.
2. **같은 mediasoup 인스턴스 잡기 (H3):** entry 파일의 실제 경로 기준으로 `require.resolve('mediasoup')` → 서버와 같은 모듈 인스턴스. 30초 동안 worker가 안 보이면 경고 로그.
3. **객체 추적 (`createRegistry`):** `mediasoup.observer` → worker → router → transport → producer/consumer 순으로 `newX` 이벤트를 구독해 Map에 넣고 `close`에서 지운다(H6). producer는 `id@transportId`로 저장한다(`pipeToRouter`가 같은 producer id를 다른 router에 만들기 때문).
4. **소켓 서버:** `MSDASH_HOOK_SOCKET`(기본 `/var/run/msdash/hook.sock`). 줄 단위 JSON 요청/응답. 소켓 권한 0666(서버는 root, 사이드카는 일반 사용자). `unref()`로 서버 종료를 막지 않는다.
5. **안전 (H1):** 모든 observer 핸들러와 요청 처리는 try/catch. 초기화 실패 시 수집만 꺼지고 서버는 그대로.

**요청 (프로토콜 버전 1, `server/src/hookProtocol.ts`와 맞춤)**

| method | 응답 |
|---|---|
| `health` | pid, mediasoup 버전, 객체 수 |
| `snapshot` | 시각, 수집 시간, 프로세스 RSS·이벤트 루프 지연 p99, workers(usage·현재 RSS), routers, transports(type·direction·ice/dtls·tuple·stats), producers(peerId·source·stats), consumers(currentLayers·stats), rooms(전역 `rooms`의 `serialize()`와 `getRouterId()`), errors |
| `transportDetail {transportId}` | transport 하나와 그 consumers/producers의 stats |

- stats 필드는 필요한 것만 골라 담는다(`RTP_FIELDS`, `TRANSPORT_FIELDS`) — 응답 크기와 훅 메모리 절약(H13).
- `getStats` 동시 호출 수 `MSDASH_HOOK_CONCURRENCY`(6), 호출당 시간 제한 `MSDASH_HOOK_CALL_TIMEOUT_MS`(2000ms). 실패는 null + `errors`에 `"worker:<pid>: timeout"` 형태로 기록 → 화면의 "w3 제외".
- 현재 RSS는 `/proc/<pid>/status`의 VmRSS(`ru_maxrss`는 최대치라서).
- 이벤트 루프 지연: `monitorEventLoopDelay(resolution 20ms)` p99에서 resolution을 뺀 값.
- 방(room) 정보는 mediasoup-demo `TerminalServer`가 만드는 전역 `rooms` Map을 공개 메서드(`serialize`, `getRouterId`)로만 읽는다.

### 5.2 사이드카 진입점 — `server/src/index.ts`

시작 순서: 설정 읽기 → 입력(hook/sim) → Store 생성 → DB 초기화·보관 정책(연결될 때까지 재시도, 1→32초) → 알림 평가기 초기화(규칙 로드, 발동 중 알림 이어받기) → 모드별 구성(edge: 정규화기·heartbeat 송신 / origin: 정규화기·생존 감시·edge 등록) → 라우트 등록 → 수집 시작 → HTTP 시작.
종료(SIGTERM/SIGINT): 수집 중지 → HTTP 닫기 → heartbeat DB 기록 마무리 → 기록 큐 flush → DB 닫기.

### 5.3 입력 — `server/src/sources/`

- `HookSource`: 요청마다 소켓 연결을 새로 연다(10초 주기라 비용이 작고 훅 재시작에 강함). 시간 제한 `MSDASH_HOOK_TIMEOUT_MS`(8000ms).
- `SimSource`: **개발용** 시뮬레이터. 훅과 같은 원시 형식(누적 카운터 포함)을 만든다. edge(pipe 입력·shard·viewer 접속/이탈)와 origin(simulcast broadcaster·edge로 나가는 pipe) 모두. 화면에 `▲ SIMULATED` 표시.
  - 장애 주입(`MSDASH_SIM_FAULT_FILE`): 파일에 `collector_down`(수집 실패) 또는 `worker_timeout:<idx>`(worker 하나 응답 없음)를 줄마다 적으면 다음 수집부터 적용. UI 상태 시험용.

### 5.4 수집·정규화 — `server/src/collector/`

| 파일 | 역할 |
|---|---|
| `collector.ts` | 수집 루프(`setInterval`, 실행 중이면 건너뜀), 상태(`ok`, 마지막 성공·오류, 연속 실패, 건너뛴 주기), 캐시(`latest` 묶음, `raw.current/previous` 스냅숏), `transportDetail`(1초 재사용). 이벤트 `batch`/`failure`. |
| `delta.ts` | `DeltaTracker`: 키별 직전 누적값 → 증가분. 첫 관측·감소(재시작)·값 없음 → `null`(그 구간은 저장 안 함). `sweep()`으로 이번 주기에 안 보인 키 삭제. `sumStrict`: 하나라도 null이면 null. |
| `topology.ts` | 스냅숏 색인(`Topology`): worker idx, router→worker, transport별 producer/consumer, **router→방송** 연결(아래), 원격 pipe 판별, peer 찾기. 공통 함수: `workerRows`(CPU%), `jitterMs`, `rttOf`, `transportState`. |
| `normalizeEdge.ts` | edge 묶음(`EdgeBatch`): viewer 샘플·세션 시작/종료, pipe 샘플, 방송×worker 샘플, worker, 수집기 상태. |
| `normalizeOrigin.ts` | origin 묶음(`OriginBatch`): broadcaster 샘플·세션(시작·상태 변화·종료), edge로 나가는 pipe 샘플, 방송×edge 연결 변화, 방송 샘플, origin viewer 현재 loss(`viewerLive`, 저장 안 함). |
| `hostCpu.ts` | `/proc/stat`으로 노드 전체 CPU%. |

**router → 방송 연결 (M6, 추정)**: ① `room.getRouterId('producer'|'consumer')`로 알려진 router ② 나머지 consumer router shard는 `pipeToRouter`가 **같은 producer id**로 복제하므로, 방송 producer router의 producer id를 가진 router를 그 방송의 shard로 본다.

**edge 정규화 규칙**

- viewer = `type==='webrtc' && appData.direction==='consumer'`인 transport. 방송은 그 transport의 router로 찾는다.
- viewer 지표: 그 transport의 모든 consumer의 `outbound-rtp` 항목 합. 레이어는 첫 video consumer의 `currentLayers`.
- 새 viewer → 세션 시작(이때 mock 신원 M1·M3·M4 생성), 사라진 viewer → 세션 종료(사유 M5). 사이드카 재시작 시 DB의 열린 세션을 이어받고(`adoptOpenSessions`), 이번 스냅숏에 없으면 종료 처리.
- pipe 수신 = 방송 **producer router** 위 PipeTransport의 producer(appData.peerId가 `__external__` 또는 없음). 같은 router의 shard용 로컬 pipe는 consumer만 가지므로 제외된다.

**origin 정규화 규칙**

- broadcaster = 방송 producer router 위 WebRTC/Plain transport(consumer 방향 아님)의 producer를 `방송/peerId`로 묶은 것. 이름은 `room.serialize()` peers에서 찾는다(실제 값).
- `broadcaster_id` = `<roomId>/<peerId>@<처음 본 epoch초>` (세션 단위). 상태: bitrate>0 → `sending`, 아니면 `idle`, 사라지면 `disconnected`.
- edge로 나가는 pipe = 다른 서버로 연결된 PipeTransport(원격 IP가 로컬 IP와 다르고 127.x가 아님). 원격 IP → edge id는 heartbeat로 받은 edge의 pipe IP(또는 `MSDASH_EDGE_TARGETS`)로 찾는다(M7). 못 찾으면 `edge_id` NULL.

### 5.5 mock — `server/src/mock/index.ts`

- `MOCK_FIELDS`: "테이블.컬럼"(또는 화면 파생 값 `viewer_report.*`, `broadcaster_report.*`) → M 번호. API가 `meta.mockFields`로 내려주고, 화면 `Mock` 컴포넌트가 이 목록으로 배지를 붙인다.
- 함수: `mockViewerIdentity`(M1·M3·M4), `mockDisconnectReason`(M5), `mockClientReport`(M2, 서버 loss와 맞물리게: loss가 높으면 freeze가 잦음), `mockViewerPlayback`(M2·M3·M4 파생), `mockBroadcasterFps`/`mockBroadcasterReport`(M8). 모두 id 해시(FNV-1a)로 결정적.

### 5.6 DB 접근 계층 — `server/src/db/`

- `rows.ts`: 정규화된 행 타입. 필드 이름 = DB 컬럼 camelCase. 값 없음 = null.
- `store.ts`: **인터페이스** (DB 교체 지점). 쓰기는 `saveBatch` 하나(+ 수집 실패 행 `saveCollectorFailure`, 알림 이벤트 2개, heartbeat). 읽기는 화면 목적별 함수: `getServerSeries`, `getWorkerSeries`, `getRoomSummary`, `getPipeSeries`, `getViewerList`, `getViewerSeries`, `getViewerLossPercentiles`, `getViewerLossDistribution`, `getAlertHistory`, `getOriginRoomSummary`, `getBroadcasters`, `getBroadcasterSeries`, `getEdges`, `getRoomEdgeMatrix` 등.
- `timescale/common.ts`: 연결 풀, **스키마 초기화**, 보관 정책, 공통 읽기.
  - 초기화: 완료 표시 테이블 `msdash_schema`가 있으면 시드만 다시(멱등). 없는데 테이블이 있으면 "적용 도중 끊긴 DB"로 보고 **public 스키마를 지우고 다시 만든다**(새 연결로 — 확장을 지운 세션에서는 timescaledb를 다시 못 만든다). 대시보드가 만들지 않은 테이블이 하나라도 있으면 절대 지우지 않고 오류.
  - 보관 정책: 시작할 때 설정값으로 `remove_retention_policy` → `add_retention_policy`.
- `timescale/edgeStore.ts`, `originStore.ts`: 모드별 구현. 배치 insert는 컬럼마다 배열 하나를 넘겨 `unnest`로 펼친다(`sql.ts insertRows`) — 행 수와 무관하게 한 문장.
- `writer.ts` (`BatchWriter`): 기록 큐. 순서대로 하나씩. DB가 죽어도 수집은 계속, 최근 30개만 보관하다 복구되면 이어서 쓴다(넘치면 오래된 것부터 버림 → 이력 빈칸).

### 5.7 알림 — `server/src/alerts/`

- `metrics.ts`: 묶음 → 지표 샘플. **서버 값만**(mock·브라우저 값 제외).
  - edge: `pipe.loss_ratio`(방송별), `viewer.loss_ratio.p50`(방송별), `viewer.bad_ratio`(방송별, loss≥5% viewer 비율), `worker.cpu_pct`(worker별), `collector.event_loop_lag_ms`.
  - origin: `broadcaster.loss_ratio`(broadcaster별), `pipe_send.loss_ratio`(방송→edge별), `worker.cpu_pct`, `collector.event_loop_lag_ms`, `edge.heartbeat_age_s`(생존 감시 타이머가 5초마다).
- `evaluator.ts` (`AlertEvaluator`):
  - 발동: 임계값을 `window_seconds` 동안 **계속** 넘음. 해소: 경고 아래로 `window_seconds` 동안 머묾.
  - warn→crit 상승은 기존 이벤트를 해소하고 crit로 다시 발동(이력에 등급 변화가 남음). crit→warn 하강은 crit 아래로 window 동안 머문 뒤.
  - 값이 사라진 대상(방송 종료 등)은 window 뒤 해소. 재시작 시 DB의 발동 중 알림을 이어받아 중복 발동 안 함.
  - `states()`: 화면용 현재 상태. 경고 임계값의 80% 이상이면 `near`(곧 울릴 수 있는 항목).
  - 평가는 직렬(Promise 체인).
- `sinks.ts`: `AlertSink` 인터페이스(`onFiring`/`onResolved`) — 외부 알림을 붙이는 자리. 지금은 `LogSink`만.

### 5.8 생존 신호 — `server/src/liveness/`

- `message.ts`: 신호 형식(v1)과 검증. 요약 숫자만: edge id, 대시보드 주소, pipe IP, 지역, 자체 점검 결과(`ok`/사유), viewer 수, 직전 신호 이후 pipe 수신 lost/expected delta, 직전 왕복 RTT.
- `edgeReporter.ts`: `EdgeLivenessSource`(묶음마다 pipe delta 누적, `take()`로 꺼내며 비움, 전송 실패 시 `restore()`로 되돌림), `PushLivenessReporter`(주기적으로 origin `POST /api/liveness`).
- `originMonitor.ts`: `OriginLivenessMonitor` — 신호를 받으면 메모리 상태를 즉시 갱신하고 응답, DB 기록(edge 등록·heartbeat)은 뒤에서 순서대로(edge가 재는 RTT가 네트워크 시간에 가깝게). edge 상태: 신호 나이 ≥ `edge_signal_age` warn(30초) → 신호 끊김 / 자체 점검 실패 또는 수신 loss ≥ `pipe_send_loss` warn → 연결됨·품질 경고 / 그 외 연결됨. `PullLivenessPoller`: pull 모드용(알려진 edge의 `GET /api/liveness`). push 모드 edge는 이 경로를 열지 않는다(delta를 두 곳이 가져가지 않도록).

### 5.9 API — `server/src/api/`

- `common.ts`: 응답 형식 `{ meta, panels }`. 패널마다 `{ok:true,data,excluded?,mock?}` 또는 `{ok:false,error,reason}`(`error`/`not_implemented`/`not_found`). `respond()`가 패널을 병렬 계산하고 하나가 실패해도 나머지는 성공. 기간(`5m/15m/1h/6h/24h`, 상세는 `session`).
- `live.ts`: 캐시(원시 스냅숏 2개) 기반 현재 값 — `workersLive`(CPU user/sys, 현재 RSS, maxrss, 컨텍스트 스위치/s, router 배치), `streamsLive`(stream별 bitrate·loss·jitter·NACK/분·PLI/분·consumer 수), `egressLive`, `layerMix`, `excludedWorkers`, `WorkerTracker`(재시작 감지).
- `diagnose.ts`: 진단·권장 문구(규칙 기반, 원인을 단정하지 않음, mock 근거면 `mock:true`).
- `edgeRoutes.ts`, `originRoutes.ts`, `alertRoutes.ts`: 화면별 엔드포인트. 목록은 [api.md](api.md).

### 5.10 HTTP — `server/src/http/`

- `server.ts`: 의존성 없는 JSON 라우터(`:param` 경로, 본문 64KB 제한, `HttpError`).
- `static.ts`: `web/dist` 정적 서빙. `/api` 아닌 GET 중 파일 없는 경로는 `index.html`(SPA). `assets/`는 1년 캐시, `index.html`은 no-cache. 경로 탈출 방지.

### 5.11 화면 — `web/src/`

| 위치 | 역할 |
|---|---|
| `App.tsx` | `/api/meta`로 edge/origin을 판단해 라우트 묶음 선택 |
| `lib/usePolling.ts` | 주기 갱신 훅: 10초/2초, 탭 숨김 시 중지·복귀 시 즉시, 연결 실패 시 2→4→8→16→30초 재시도(이전 값 유지), 첫 응답 5초 초과 시 `slow` |
| `lib/connection.ts` | 전역 연결 상태(배너용), "지금 다시 시도"가 모든 polling을 즉시 실행 |
| `lib/usePage.ts` | 화면 하나의 polling + 패널 꺼내기, 기간을 URL `?range=`에 저장 |
| `lib/format.ts` | 표시 형식(null은 "—") |
| `components/Panel.tsx` | **패널 상태 처리**: 스켈레톤(5초 넘으면 "수집기 응답이 늦습니다"), 종류별 빈 상태 문구, 부분 실패, `not_implemented`/`not_found`, 제외 항목, MOCK 배지. `PageSkeleton`(첫 로딩) |
| `components/Layout.tsx` | 사이드바, 연결 불가 배너, 제목 줄과 갱신 상태(Live / 마지막 수신 N초 전: 30초 노랑, 2분 빨강), `StaleScope`(stale이면 값 흐림), 기간 탭 |
| `components/Status.tsx` | 아이콘+문구 상태(✓ ● ▲ ✕), `Mock` 배지, `levelOf` |
| `components/Charts.tsx` | SVG 차트(선·스파크라인·분포·시간별 막대·레이어 비율·막대), 너비는 callback ref + ResizeObserver |
| `components/Blocks.tsx` | KPI 카드, 진단 목록, 이벤트, 타임라인 |
| `pages/edge/*` | Overview, Workers, Broadcasts, Pipe, Viewers(+요약 패널), ViewerDetail(2초 live) |
| `pages/origin/*` | Overview, Rooms(broadcaster 카드), Broadcaster(2초 live), Edges(매트릭스) |
| `pages/Alerts.tsx` | edge·origin 공통 |
| `styles.css` | 디자인 토큰(지시서 8절 색), 레이아웃, 반응형(1100px·860px) |

시안과 다르게 한 부분(지시서 우선): 상단 띠 "집계 노드" → "이 서버의 수집 상태", 알림 확인 버튼·Slack 문구 없음, 규칙 사용 여부는 읽기 전용, Pipe의 origin 비교 패널은 미구현 표시, "샘플 데이터" 태그 대신 `SIMULATED`/`MOCK`.

---

## 6. 지표 정의

| 지표 | 계산 | 위치 |
|---|---|---|
| **수신 측 expected** (pipe·broadcaster) | `Δ packetCount − Δ packetsRepaired + Δ packetsLost`. mediasoup `RtpStreamRecv`의 `packetCount`는 RTX 복구분을 포함하고, `packetsLost`는 원래 전송분 기준(복구 전) | `normalizeEdge.ts`, `normalizeOrigin.ts` |
| **수신 측 loss (원본)** | `Σ lost / Σ expected` (구간) | 화면: 읽을 때 계산 |
| **수신 측 loss (복구 후)** | `max(0, Σ lost − Σ repaired) / Σ expected` | Pipe·Broadcaster 상세 |
| **viewer expected** | `Δ packetCount`(SFU가 그 viewer에게 보낸 패킷, consumer outbound-rtp) — 근사 | `normalizeEdge.ts` |
| **viewer loss** | `Σ Δ packetsLost / Σ expected`. packetsLost는 viewer RR 값 → 복구 후에 가까움 (M9) | |
| **loss 기본 표시** | 최근 10초(수집 한 구간) 비율. 목록·요약은 최근 15초 창 | API |
| **p50 / p95** | viewer마다 구간 loss를 먼저 구한 뒤 백분위 (`percentile_cont`) | `getViewerLossPercentiles` |
| **나쁜 viewer** | 구간 loss ≥ 5% (`BAD_VIEWER_LOSS`) | `alerts/metrics.ts` |
| **jitter (ms)** | `jitter / clockRate × 1000` (mediasoup 값은 RTP timestamp 단위; video 90000, opus 48000) | `topology.ts jitterMs` |
| **RTT** | `roundTripTime`, 0은 측정 안 됨 → NULL. 여러 stream이면 최댓값 | `topology.ts rttOf` |
| **worker CPU %** | `Δ(ru_utime + ru_stime) / Δ벽시계 × 100` | `workerRows`, `workersLive` |
| **노드 CPU %** | `/proc/stat` idle 비율의 변화 | `hostCpu.ts` |
| **egress** | 모든 transport `sendBitrate` 합 (viewer=WebRTC, pipe=PipeTransport) | `live.ts egressLive` |
| **레이어 분포** | spatial ≥2 High, 1 Mid, 0 Low | `live.ts layerMix` |
| **레이어 전환/분** | 같은 viewer의 연속 샘플에서 spatial layer가 바뀐 횟수 / 분 (SQL `lag`) | `getLayerSwitchesPerMinute` |
| **edge 수신 loss (heartbeat)** | 신호 사이 pipe lost/expected delta 합 | `edgeReporter.ts` |

모든 시각은 **수집 서버가 찍은 시각**(훅의 `Date.now()`, heartbeat는 origin이 받은 시각). 클라이언트 시계는 쓰지 않는다.

---

## 7. DB 스키마

### 7.1 edge (`db/edge_schema.sql`)

| 테이블 | 종류 | 내용 |
|---|---|---|
| `room` | 일반 | 방송 목록(처음·마지막 본 시각) |
| `viewer_session` | 일반 | viewer 세션: `viewer_id`(=consumer transport id), 방송, worker, 접속·종료 시각, 종료 사유(M5), `peer_id`·`display_name`·`device_flag`·`device_class`(M1), `network_type`(M3), `user_agent`(M4) |
| `alert_rule`, `alert_event` | 일반 | 알림 규칙(시드), 이벤트(firing→resolved) |
| `collector_sample` | hypertable | 수집기 상태: 훅 응답 여부, 수집 시간, 건너뜀, 이벤트 루프 지연, Node RSS, 노드 CPU |
| `worker_sample` | hypertable | worker CPU·현재 RSS·객체 수 |
| `room_sample` | hypertable | 방송×worker: viewer 수, pipe producer 수, 나가는·들어오는 bitrate |
| `pipe_sample` | hypertable | pipe producer별: expected·lost·**repaired**, bitrate, RTT, jitter, NACK, PLI |
| `viewer_sample` | hypertable | viewer별: expected·lost·NACK·재전송, RTT, bitrate, 레이어, transport 상태 + 브라우저 보고 그룹(`client_*`, M2) |
| `viewer_room_1m`, `pipe_room_1m` | continuous aggregate | 1분 집계 |
| `msdash_schema` | 일반 | 초기화 완료 표시 |

### 7.2 origin (`db/origin_schema.sql`)

| 테이블 | 내용 |
|---|---|
| `room`, `alert_rule`, `alert_event`, `collector_sample`, `worker_sample`, `msdash_schema` | edge와 같음 |
| `edge` | edge 목록: id, 대시보드 주소, 지역, **ip**(M7 대조용), 처음 본 시각 — heartbeat가 자동 등록 |
| `broadcaster_session` | broadcaster 세션: 방송, 이름, worker, 접속·종료, 상태(sending/idle/disconnected) |
| `room_edge_link` | 방송×edge 연결 현재 상태 (connected/closed) |
| `broadcaster_sample` | 입력 품질: bitrate, fps(M8), expected·lost·**repaired**, RTT, jitter, NACK, PLI, 활성 레이어 수 |
| `room_sample` | origin 직접 viewer 수, edge로 나가는 bitrate 합 |
| `pipe_send_sample` | origin→edge pipe: edge id(추정)·원격 IP, expected·lost(edge RR), bitrate, RTT, NACK, PLI |
| `edge_heartbeat` | 신호: ok, RTT, viewer 수, 수신 lost·expected delta |

### 7.3 알림 규칙 시드 (`db/*_seed.sql`, Q7)

| 규칙 | 지표 | 경고 | 심각 | 유지 |
|---|---|---|---|---|
| edge `pipe_loss` | pipe.loss_ratio | 2% | 5% | 30초 |
| edge `viewer_loss_p50` | viewer.loss_ratio.p50 | 2% | 5% | 60초 |
| edge `viewer_bad_ratio` | viewer.bad_ratio | 10% | 25% | 60초 |
| 공통 `worker_cpu` | worker.cpu_pct | 70% | 90% | 60초 |
| 공통 `collector_lag` | collector.event_loop_lag_ms | 100ms | 500ms | 30초 |
| origin `broadcaster_loss` | broadcaster.loss_ratio | 2% | 5% | 30초 |
| origin `pipe_send_loss` | pipe_send.loss_ratio | 2% | 5% | 30초 |
| origin `edge_signal_age` | edge.heartbeat_age_s | 30초 | 120초 | 즉시 |

### 7.4 AGENT_TASK 초안 대비 변경

- `viewer_sample.packets_lost_unrecovered` **삭제**(M9), `nack_count`·`packets_retransmitted`·`worker_idx` 추가.
- `pipe_sample`·`broadcaster_sample`에 `packets_repaired` 추가(수신 측은 원본·복구 후 둘 다 실제 값).
- `viewer_session`에 `peer_id`·`display_name`·`device_flag` 추가.
- `collector_sample`(edge·origin), `pipe_send_sample`(origin), `msdash_schema` 추가.
- origin `edge.ip` 추가, `edge_heartbeat.recv_loss_pct` → `recv_packets_lost`·`recv_packets_expected`(비율 저장 금지 규칙).

---

## 8. 설정 (환경 변수) 전체

### 8.1 사이드카 (`msdash` 컨테이너, `server/src/config.ts`)

| env | 기본값 | 설명 |
|---|---|---|
| `MSDASH_MODE` | edge | `edge` / `origin` |
| `MSDASH_SERVER_ID` | `NODE_NAME` 또는 `<mode>-local` | 화면·origin에 보일 이름 |
| `MSDASH_MEDIASOUP_SOURCE` | hook | `hook` / `sim`(개발용) |
| `MSDASH_HOOK_SOCKET` | /var/run/msdash/hook.sock | 훅 소켓 경로 |
| `MSDASH_HOOK_TIMEOUT_MS` | 8000 | 훅 요청 시간 제한 |
| `MSDASH_COLLECT_INTERVAL_MS` | 10000 | 수집 주기 |
| `MSDASH_MOCK` | 1 | 0이면 mock 값을 채우지 않음 |
| `MSDASH_DATABASE_URL` | postgres://postgres:dev@127.0.0.1:5432/msdash | DB 주소 |
| `MSDASH_DB_AUTO_INIT` | 1 | 0이면 스키마가 없을 때 시작 실패 |
| `MSDASH_DB_SCHEMA_DIR` | (이미지) /app/db | 스키마 파일 위치 |
| `MSDASH_WEB_DIR` | (이미지) /app/web/dist | 화면 파일 위치 |
| `MSDASH_RETENTION_VIEWER_HOURS` | 48 | viewer 원본 보관 |
| `MSDASH_RETENTION_RAW_DAYS` | 7 | 그 외 원본 보관 |
| `MSDASH_RETENTION_AGG_DAYS` | 14 | 1분 집계 보관 (origin은 room_sample·edge_heartbeat) |
| `MSDASH_HTTP_HOST` / `MSDASH_HTTP_PORT` | 0.0.0.0 / 8080 | 배포에서는 18080 사용 |
| `MSDASH_PUBLIC_URL` | http://`SERVER_IP`:포트 | 다른 서버가 이 대시보드를 여는 주소 |
| `MSDASH_NIC_CAPACITY_BPS` | 1000000000 | NIC 용량 표시 (Overview "송신 트래픽") |
| `MSDASH_LIVENESS_MODE` | push | push / pull |
| `MSDASH_HEARTBEAT_INTERVAL_MS` | 10000 | 신호 주기 |
| `MSDASH_ORIGIN_URL` | 없음 | (edge) origin 대시보드 주소 — 신호 대상, 사이드바 링크 |
| `MSDASH_PIPE_IP` | `SERVER_IP` | (edge) origin이 보는 이 edge의 pipe IP |
| `MSDASH_REGION` | 없음 | (edge) 지역 표시 |
| `MSDASH_EDGE_TARGETS` | 없음 | (origin) `id=ip=url,...` 미리 알려 줄 edge (heartbeat로 자동 등록되므로 선택) |
| `MSDASH_LOG_LEVEL` | info | debug/info/warn/error |
| `MSDASH_SIM_ROOMS` / `_VIEWERS` / `_WORKERS` | 3 / 40 / 4 | 시뮬레이터 규모 (`ROOMS=0`이면 빈 서버) |
| `MSDASH_SIM_FAULT_FILE` | 없음 | 시뮬레이터 장애 주입 파일 |

### 8.2 훅 (`mediasoup-server` 컨테이너)

| env | 기본값 | 설명 |
|---|---|---|
| `NODE_OPTIONS` | — | `--require /dashboard-hook/msdash-hook.cjs` (이것으로 훅이 붙는다) |
| `MSDASH_HOOK_SOCKET` | /var/run/msdash/hook.sock | 사이드카와 같은 경로 |
| `MSDASH_HOOK_MATCH` | mediasoup-demo-server | 훅을 켤 entry 파일 이름 |
| `MSDASH_HOOK_DISABLE` | — | `1`이면 훅을 끈다 (`NODE_OPTIONS`를 지우지 않고 끄기) |
| `MSDASH_HOOK_CONCURRENCY` | 6 | getStats 동시 호출 수 |
| `MSDASH_HOOK_CALL_TIMEOUT_MS` | 2000 | getStats 호출당 시간 제한 |

---

## 9. 수정 가이드

### 9.1 새 지표 하나를 끝까지 추가하기 (예: viewer의 `firCount`)

1. **훅:** 필드가 `RTP_FIELDS`/`TRANSPORT_FIELDS`에 없으면 추가 (`hook/msdash-hook.cjs`). → ConfigMap 갱신 + mediasoup Pod 재시작 필요.
2. **원시 타입:** `server/src/hookProtocol.ts`의 `RawRtpStat` 등에 필드 추가.
3. **스키마:** `db/edge_schema.sql`에 컬럼 추가. **이미 운영 중인 DB는 자동으로 바뀌지 않는다** → `ALTER TABLE viewer_sample ADD COLUMN fir_count integer;`를 직접 실행(압축 hypertable도 ADD COLUMN은 가능).
4. **행 타입:** `server/src/db/rows.ts`(`ViewerSampleRow`)에 필드.
5. **정규화:** `server/src/collector/normalizeEdge.ts`에서 delta 계산(`d('firCount')` 같은 방식, 키는 기존 규칙을 따름).
6. **저장:** `server/src/db/timescale/edgeStore.ts`의 `VIEWER_COLUMNS`에 한 줄.
7. **읽기:** 필요한 읽기 함수 SQL과 `store.ts` 반환 타입.
8. **API:** `server/src/api/edgeRoutes.ts` 해당 패널.
9. **화면:** `web/src/pages/edge/...`.
10. **시험:** `server/test/collector.test.ts`에 기대값, `npm test`, `scripts/api-smoke.mjs`.

### 9.2 mock을 실제 값으로 바꾸기 (서버 수정이 허용된 경우)

예: M1(viewer 이름·기기).
1. mediasoup-demo `Peer.ts`의 transport 생성 `appData`에 `peerId` 추가 (서버 쪽 변경).
2. 훅 `describeTransport`에서 `appData.peerId`를 응답에 포함.
3. `normalizeEdge.ts`의 세션 시작에서 `mockViewerIdentity` 대신 `topology.peerOf(roomId, transport.peerId)`의 `displayName`·`device`를 쓴다.
4. `mock/index.ts`의 `MOCK_FIELDS`에서 `viewer_session.peer_id`·`display_name`·`device_flag`·`device_class` 항목을 **지운다** → 화면 배지가 자동으로 사라진다.
5. 알림에 쓰려면 `alerts/metrics.ts`에 지표 추가(mock이 아니게 됐으므로).

M2(브라우저 보고)는 클라이언트 보고 경로가 생기면 훅이 Peer 이벤트를 받을 방법이 필요하다(서버가 이벤트를 `Server.observer`나 transport appData로 노출). [collection-design.md](collection-design.md) M11 참고.

### 9.3 화면 하나·패널 하나 추가

- API: 해당 `*Routes.ts`의 `respond(ctx, { 새패널: async () => ... })`. 실패하면 그 패널만 오류.
- 화면: `usePage(path, 10)`의 `p('새패널')`을 `<Panel panel={...} meta={meta} slow={page.slow} empty={...}>`로 감싸면 로딩·빈 상태·실패·MOCK 배지가 자동.
- 새 페이지는 `App.tsx` 라우트와 `components/Layout.tsx`의 `EDGE_NAV`/`ORIGIN_NAV`.

### 9.4 알림 규칙 바꾸기

- 임계값·유지 시간: DB에서 직접 수정 후 사이드카 재시작(규칙은 시작할 때 읽는다).
  ```sql
  UPDATE alert_rule SET warn_above = 0.03, crit_above = 0.06, window_seconds = 60 WHERE rule_id = 'pipe_loss';
  ```
  시드 파일(`db/*_seed.sql`)은 새 DB에만 들어간다(`ON CONFLICT DO NOTHING`이라 기존 값을 덮지 않음).
- 새 규칙: 지표를 `alerts/metrics.ts`에 추가하고 시드에 행 추가(+ 운영 DB에 INSERT).

### 9.5 외부 알림(Slack 등) 붙이기

`server/src/alerts/sinks.ts`에 `AlertSink` 구현을 만들고 `index.ts`의 `new AlertEvaluator(store, [new LogSink(), new SlackSink(...)])`에 넣는다. sink 실패는 평가·저장에 영향 없음.

### 9.6 DB를 바꾸기

`server/src/db/store.ts`의 `EdgeStore`/`OriginStore`를 새로 구현(예: `db/clickhouse/`)하고 `index.ts`에서 생성만 바꾼다. 화면·API·수집기는 SQL을 직접 쓰지 않는다. 시간 bucket 집계·보관 정책·압축은 구현 안에서 처리.

### 9.7 heartbeat를 pull로 바꾸기

양쪽 사이드카에 `MSDASH_LIVENESS_MODE=pull`. origin은 알려진 edge(이미 등록됐거나 `MSDASH_EDGE_TARGETS`)의 `GET <dashboardUrl>/api/liveness`를 주기적으로 부른다. 처음 등록을 위해 `MSDASH_EDGE_TARGETS`를 주는 것이 안전하다.

### 9.8 훅을 고친 뒤 반영

```bash
kubectl -n qos create configmap msdash-hook --from-file=msdash-hook.cjs=<경로>/msdash-hook.cjs \
  --dry-run=client -o yaml | kubectl apply -f -
# 훅은 서버 시작 때 로드되므로 mediasoup Pod 재시작 필요 (방송 없는 시간에)
```

### 9.9 사이드카·화면을 고친 뒤 반영

```bash
cd mediasoup-dashboard
docker build -t ghcr.io/youngrheecho/mediasoup-dashboard:<새 태그> .
docker push ghcr.io/youngrheecho/mediasoup-dashboard:<새 태그>
# yaml의 msdash image 태그를 바꾸고 apply (사이드카만 바꿔도 Pod 전체가 재시작된다)
```

---

## 10. 개발 · 시험 방법

### 10.1 로컬 실행 (WSL, mediasoup 없이)

```bash
docker run -d --name msdash-tsdb -e POSTGRES_PASSWORD=dev -p 55432:5432 timescale/timescaledb:2.17.2-pg16
cd mediasoup-dashboard/server && npm install && npm run build
cd ../web && npm install && npm run build
cd ../server
MSDASH_MODE=edge MSDASH_MEDIASOUP_SOURCE=sim MSDASH_HTTP_PORT=18081 \
MSDASH_DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/dev_edge node dist/src/index.js
# 브라우저 http://localhost:18081  (DB는 비어 있으면 자동 생성 — 미리 CREATE DATABASE dev_edge 필요)
```

화면만 고칠 때: `cd web && MSDASH_API=http://127.0.0.1:18081 npm run dev` (Vite 개발 서버가 /api를 사이드카로 넘김).

### 10.2 테스트

| 명령 | 내용 |
|---|---|
| `cd server && npm test` | 단위 테스트 13개: delta·jitter·shard 연결·viewer 세션·재시작 구간 버림·origin broadcaster/pipe/연결·알림 window·등급 변화·재시작 이어받기·mock 제외·heartbeat delta·신호 끊김 |
| `node scripts/api-smoke.mjs http://127.0.0.1:18081 edge` | 모든 edge 엔드포인트·패널 성공 여부 (origin은 `... origin`). 방송이 하나 이상 있어야 함 |
| `node scripts/read-smoke.mjs` | DB 읽기 함수 직접 호출 (`MSDASH_MODE`, `MSDASH_DATABASE_URL` 필요) |

### 10.3 실제 mediasoup로 훅 시험 — `tools/hook-harness/`

`mediasoup-demo-server`라는 이름의 하네스(파일 이름이 훅 활성 조건과 같아야 함). npm `mediasoup@3.19.14`를 설치한 폴더에 `bin/mediasoup-demo-server`로 두고 실행한다. plain broadcaster(3% 유실) → origin→edge 원격 pipe → pipeToRouter → shard → viewer transport를 만든다.

```bash
mkdir -p ~/hooktest/bin && cd ~/hooktest && npm init -y && npm i mediasoup@3.19.14
cp <repo>/tools/hook-harness/mediasoup-demo-server bin/
HARNESS_ROLE=edge HARNESS_ETH_IP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1) \
MSDASH_HOOK_SOCKET=/tmp/msdash.sock NODE_OPTIONS="--require <repo>/hook/msdash-hook.cjs" \
node bin/mediasoup-demo-server &
# 다른 터미널: 사이드카를 MSDASH_MEDIASOUP_SOURCE=hook MSDASH_HOOK_SOCKET=/tmp/msdash.sock 으로 실행
```

`HARNESS_ROLE=origin`이면 전역 rooms가 origin router를 방송 router로 보여 origin 모드 시험이 된다.

### 10.4 UI 상태 시험 — `tools/ui-states/`

- `uiproxy.mjs <사이드카포트>`: 18085에서 받아 사이드카로 넘기는 프록시. `/tmp/uiproxy-mode` 파일 내용으로 `normal`/`slow`(API 8초 지연)/`down`(API 연결 끊기). 요청마다 로그.
- `cdp.ps1`: Windows의 headless Edge를 DevTools 프로토콜로 제어(실시간 캡처·JS 실행). `states_live.ps1`(연결 끊김·복구·느린 로딩), `states_bg.ps1`(탭 숨김 시 polling 중지·복귀). 스크립트 안의 WSL 경로·포트는 환경에 맞게 수정.
- 장애 주입: 시뮬레이터 사이드카에 `MSDASH_SIM_FAULT_FILE=/tmp/sim-fault`, 파일에 `collector_down` 또는 `worker_timeout:3`.

---

## 11. 현재 배포 상태와 운영

### 11.1 실제로 적용된 방식

저장소의 원본 매니페스트(`qos/network/mediasoup-*.yaml`)와 **실제 클러스터의 매니페스트가 다르다.** 실제 적용은 사용 중인 yaml에 직접 추가했다.

| 대상 | 파일 | 추가한 것 |
|---|---|---|
| edge | `mediasoup-edge-multpod0.yaml` (Pod `mediasoup-edge-0`, hostPort 방식, SERVER_IP=192.0.2.20) | 볼륨 3개(`msdash-hook` ConfigMap, `msdash-sock` emptyDir, `msdash-db` hostPath `/var/lib/msdash/mediasoup-edge-0`), `mediasoup-server`에 env 2개·마운트 2개, 컨테이너 `msdash`(hostPort 18080)·`msdash-db` |
| origin | origin Deployment yaml (hostNetwork, 노드 192.0.2.10) | 같은 구성, `MSDASH_MODE=origin`, hostPath `/var/lib/msdash/origin` |
| 공통 | ConfigMap `msdash-hook` (qos 네임스페이스) | 훅 파일 |

- 대시보드 주소: origin `http://192.0.2.10:18080`, edge `http://192.0.2.20:18080`.
- DB 비밀번호는 yaml에 직접(`"1234"`) — Secret으로 바꾸는 것을 권장. origin은 hostNetwork라 DB(127.0.0.1)가 노드 localhost에 열린다.
- edge Pod를 더 늘리면: Pod마다 `MSDASH_PIPE_IP`(그 Pod의 SERVER_IP)·`MSDASH_PUBLIC_URL`·hostPath 경로(Pod 이름)를 바꾼다. 같은 노드에 두 edge Pod면 hostPort 18080이 겹치므로 포트도 다르게.
- `deploy/k8s/` kustomize overlay는 저장소 원본 yaml 기준이라 지금 클러스터에는 그대로 맞지 않는다(Q9).

### 11.2 확인 명령

```bash
kubectl -n qos logs mediasoup-edge-0 -c mediasoup-server | grep msdash-hook   # enabled, listening
kubectl -n qos logs mediasoup-edge-0 -c msdash | tail
curl http://192.0.2.20:18080/api/health        # source=hook, collector.ok=true, dbLastError=null
curl http://192.0.2.10:18080/api/origin/edges  # edge 등록·상태
```

### 11.3 문제 해결

[deploy.md](deploy.md) 9절. 이번 배포에서 실제로 겪은 것:
- `ContainerCreating`에서 멈춤 → `configmap "msdash-hook" not found`. ConfigMap을 먼저 만들어야 한다.
- env 값 `1234`처럼 숫자는 따옴표 필요(`"1234"`).
- 훅 마운트를 `args:` 아래에 두면 args 항목으로 읽힌다 → `volumeMounts:` 안에.
- `kubectl delete <파일>`은 `-f` 필요.
- edge "Pipe 수신"이 항상 "기록 없음" (2026-10-23 수정) → `fec-merged` 브랜치의 `Server.edge.ts` `/pipe/produce`가 producer `appData.peerId`를 `__external__`로 넣은 뒤 origin이 보낸 appData로 덮어써서 broadcaster peerId가 들어온다. 사이드카가 peerId로 pipe producer를 거르고 있어 전부 빠졌다. 이제 peerId 대신 "방송 producer router 위 PipeTransport의 producer"로 판단한다(`normalizeEdge.ts`, `edgeRoutes.ts`).
- viewer·broadcaster IP가 pod IP(10.244.x.x)로 보임 (2026-10-23 수정) → WS `remoteAddress`는 pod 네트워크 주소다. mediasoup이 hostNetwork로 돌기 때문에 WebRtcTransport `getStats()`의 `iceSelectedTuple.remoteIp`가 실제 클라이언트 IP다. `topology.ts`의 `clientIpOf`로 읽어 edge viewer 세션(`viewer_session.remote_ip`, ICE 연결이 늦으면 다음 주기에 채움)과 origin broadcaster 실시간 값(`broadcasterLive.remoteIp`)에 쓴다. 훅은 바꾸지 않았다(이미 transport stats에 들어 있음). NAT/TURN을 거치면 그 장비의 IP가 보인다.
- Overview 정리 (2026-10-23) → "가장 나쁜 viewer"를 "Viewer summary"(양호·loss 5% 이상·freeze 인원 + 문제 viewer만)로, "이 서버가 중계 중인 방송"→"중계 중인 방송", "이벤트 (이 서버)"→"서버 이벤트", origin "이 서버 viewer 품질"→"Viewer 품질", "NIC Egress"→"송신 트래픽"(mediasoup 송신량 합, NIC 실측 아님). NIC 용량 기본값 10 Gbps → 1 Gbps. "추가 수용 가능"(단순 추정) 삭제. Worker CPU 카드 색은 알림 규칙 `worker_cpu` 값을 따른다.
- M2 브라우저 보고 연결 (2026-10-23) → 훅 `describeTransport`가 `appData.clientStats`를 읽는다(알려진 숫자 칸만). 훅 ConfigMap 갱신과 mediasoup 서버 재시작이 필요하다. 사이드카 `collector/clientStats.ts`, `normalizeEdge.ts` `#clientReport`, `edgeRoutes.ts` `liveClient`(실시간은 최근 보고 두 개 사이 구간).
- 레이어 표기 (2026-10-23) → 모든 화면이 `L0(Low)`/`L1(Mid)`/`L2(High)`로 통일. viewer는 consumer `currentLayers.spatialLayer`, stream 목록(Pipe·Broadcasts·origin broadcaster)은 rid 끝 숫자, 없으면 getStats 순서(`live.ts` `streamSpatialLayer`).
- origin broadcaster의 네트워크 종류·브라우저 mock 제거 (2026-10-23) → 브라우저는 room peer `device`, IP는 위와 같이 실제 값. `broadcaster_report.*`(해상도·인코더·품질 제한 등)는 여전히 mock(M8).
- Overview 재설계 (2026-10-27, handoff/HANDOFF.md) → Origin·Edge Overview만 바꿨다. 상태 배너 → 연결 흐름 → 핵심 카드(Origin 3개, Edge 2개) → 하단(방송 + 알림 / 중계 중인 방송 + 참고). 등급은 알림 규칙 판정을 그대로 쓴다: 배너는 진행 중 알림(심각 crit, 경고 warn, 수집 실패 warn), "문제 N명"은 그 대상에 진행 중 알림이 있거나 지금 값이 규칙 경고 값 이상, viewer는 기존 `BAD_VIEWER_LOSS` 기준. 화면에 숫자 임계치는 쓰지 않는다. 서버 `api/overview.ts`(공통 판정), `edgeRoutes.ts`·`originRoutes.ts`의 overview 패널, 화면 `components/Overview.tsx`, 스타일은 `styles.css`의 `.ov`/`.lv-*`(다른 탭에는 영향 없음). 한글 글꼴 `@fontsource/ibm-plex-sans-kr` 추가. edge 칸은 최대 3개(1~2개는 카드, 3개 이상은 카드 2 + "외 N개", 접힌 쪽 문제는 그 카드 색과 문구로 노출). origin pipe 송신을 edge로 매칭하지 못하면(`pipe_send_sample.edge_id` NULL, 보통 edge `MSDASH_PIPE_IP`와 실제 pipe 상대 IP가 다를 때) 연결 흐름 아래에 상대 IP와 함께 경고를 띄운다. 신호를 한 번도 안 보낸 edge는 `edge_signal_age` 알림이 울리지 않으므로, 끊긴 edge가 있으면 배너를 최소 "주의"로 올린다. 제거: worker CPU 막대 목록, Viewer 품질 분포, 송신 트래픽·Viewers·loss 5% viewer 카드, 그래프, 이벤트 목록(→ Alerts·각 탭).

---

## 12. 검증 이력 요약

| 단계 | 확인한 것 |
|---|---|
| 1 스키마 | TimescaleDB 2.17.2에서 두 스키마 적용, 1분 집계·압축 chunk 읽기·쓰기 |
| 2 수집 | 실제 mediasoup(npm 3.19.14) + 훅: pipe loss ≈ 주입 3%, shard 연결, worker CPU·RSS, origin broadcaster 이름(실제)·edge 추정. 훅이 npm에서는 안 켜짐(H2). 소켓 없을 때 `hook_ok=false` 기록 |
| 3 알림·heartbeat | origin 1 + edge 2: 자동 등록, edge 종료 34초 뒤 신호 끊김 경고, pipe loss·나쁜 viewer 비율 경고, heartbeat RTT 8~11ms |
| 4 API | 모든 엔드포인트·패널 정상(시뮬레이터), 실제 mediasoup에서 live 엔드포인트·CPU user/sys·컨텍스트 스위치 |
| 5·6 화면 | edge 7개·origin 4개 화면을 시안과 비교·수정 |
| 7 UI 상태 | 로딩·빈 상태·stale(30초/2분)·부분 실패·연결 불가·재시도·복구·탭 숨김 시 중지 ([ui-states.md](ui-states.md)) |
| 배포 | 이미지 빌드·실행(일반 사용자), kustomize 렌더링, 실제 클러스터에서 `source: hook`, `collector.ok: true`, DB 기록 정상 |
