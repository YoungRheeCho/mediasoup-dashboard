# mediasoup 모니터링 대시보드 — 구현 작업 지시서

이 문서는 설계 논의 결과를 구현 담당 agent에게 넘기기 위한 것입니다.
"확정"으로 표시된 항목은 그대로 따르고, "미정"으로 표시된 항목은 임의로 정하지 말고 질문하거나 가정을 명시한 채로 진행하세요.

## 1. 목표

mediasoup 서버가 수집하는 데이터를 **수집·저장·모니터링**하는 웹 대시보드를 만든다.
읽기 전용 데모이며 인증은 없다. 제어 동작(방송 종료, viewer 퇴장 등)은 만들지 않는다.

## 2. 시스템 구조 (확정)

- SFU는 **origin + edge** 구조다.
- broadcaster는 origin으로 송출한다. 한 roomId에 broadcaster가 여러 명일 수 있고, 방송(room)도 여러 개일 수 있다.
- **origin → edge 단방향 producer pipe만** 존재한다. edge → origin 방향은 없다.
- viewer는 origin과 edge 양쪽에 접속할 수 있다.
- edge는 약 3~4대, edge당 동시 viewer는 최대 200~300명 규모를 가정한다.
- 각 서버는 **자기 자신의 데이터만** 수집·저장·표시한다.

### 대시보드는 두 종류다

| 종류 | 보는 범위 | 하지 않는 것 |
|---|---|---|
| **edge 대시보드** (서버마다 하나) | 이 edge의 worker, 방송(router), pipe 수신 품질, viewer 목록과 개별 viewer 재생 상세, 알림 | 다른 서버 데이터 표시 |
| **origin 대시보드** | 방송(room), broadcaster, 연결된 edge 목록 | edge의 상세 데이터 집계·표시. edge 상세는 edge 대시보드로 링크만 한다 (새 탭) |

## 3. 확정된 결정 사항

1. **저장소:** TimescaleDB를 쓴다. edge마다 로컬 DB 하나, origin도 자체 DB 하나. 중앙 집계 DB는 만들지 않는다.
2. **DB 교체 가능성:** 나중에 DB를 바꿀 수 있도록 접근을 목적별 함수 뒤에 숨긴다 (아래 5절). 범용 ORM 추상화는 만들지 않는다.
3. **보관:** 며칠 단위 이력을 남긴다. 기본값은 viewer 원본 48시간, 그 외 원본 7일, 1분 집계 14일 (조정 가능하게 설정으로 둔다).
4. **viewer score는 표시하지 않는다.** mediasoup의 producer/consumer score를 화면·알림에 쓰지 않는다. loss, RTT, freeze, fps 같은 원시 지표를 쓴다.
5. **라이브 지연(live latency)은 표시하지 않는다.**
6. **정확도 정책:** 개별 viewer 상세 화면에서는 정확한 값을 보여 준다. 목록·집계에서는 적당한 수준의 오차를 허용한다.
7. **시계 차이:** origin과 edge 서버의 시계가 조금 어긋나는 것은 허용한다. 모든 시각은 **수집 서버가 찍은 시각**을 쓴다. client 시계는 쓰지 않는다.
8. **갱신 주기:** 목록·개요·추이 화면은 약 10초. 개별 viewer 상세와 broadcaster 상세는 화면이 열려 있는 동안만 2초. 백그라운드 탭에서는 갱신을 멈추고 복귀 시 즉시 1회 갱신한다.
9. **알림:** 서버가 규칙을 직접 평가하고 이력을 저장한다 (6.3절). 화면에서 보는 것과 별개로 서버 쪽에서 평가해야 한다.
10. **죽은 서버 감지:** origin이 각 edge의 "마지막 신호 시각"으로 판단한다 (6.4절).
11. **수집 계층 부하 완화책을 적용한다** (4.3절).

## 4. 수집 계층

### 4.1 입력

- mediasoup `getStats()` (Producer, Consumer, Transport, PipeTransport), `worker.getResourceUsage()`, 서버가 알고 있는 router/transport/producer/consumer 목록.
- viewer 브라우저가 보내는 보고값 (WebRTC `getStats`: freeze, 디코딩 fps, jitter buffer, dropped frames 등).

### 4.2 정규화 규칙 (확정)

1. **이름·단위 통일.** bitrate는 bps, 시간은 ms, 시각은 UTC `timestamptz`. 필드 이름은 DB 스키마 컬럼 이름을 따른다.
2. **누적값은 증가분(delta)으로 변환한다.** 직전 수집값과의 차이를 저장한다. 서버 재시작 등으로 누적값이 줄어들면 그 구간은 저장하지 않는다.
3. **loss는 비율로 저장하지 않는다.** `packets_lost`와 `packets_expected` 두 delta로 저장하고, 비율은 읽을 때 `sum(lost)/sum(expected)`로 계산한다.
4. **공통 식별자를 붙인다.** `room_id`, `worker_idx`, `viewer_id` 등. 이름이 바뀌어도 이어서 볼 수 있어야 한다.
5. **값 없음(NULL)과 0을 구분한다.** 수집 실패·보고 없음은 NULL.
6. **서버가 잰 값과 브라우저가 보고한 값을 분리해서 저장한다.** 보고가 없으면 `client_reported=false`, 관련 컬럼은 NULL.
7. 집계와 알림의 기준은 **서버 값**이다. 브라우저 보고값은 viewer 상세 화면에서만 쓴다.

### 4.3 부하 완화 (확정)

- 수집 주기는 기본 10초. 서버 전체 통계를 **한 번 수집해 메모리에 캐시**하고, 여러 요청(화면, 알림 평가, DB 기록)이 같은 캐시를 읽는다. 화면 요청마다 `getStats()`를 호출하지 않는다.
- 2초 갱신은 해당 viewer 한 명의 consumer 통계만 호출한다. 열려 있는 상세 화면이 없으면 호출하지 않는다.
- `getStats()`는 worker와 IPC를 하므로, 한 주기 안에서 동시 호출 수를 제한한다 (예: 순차 또는 낮은 동시성). 수집이 한 주기를 넘기면 다음 주기를 건너뛰고 경고를 남긴다.
- DB 기록은 샘플을 모아서 **배치 insert** 한다.

### 4.4 loss의 정의 (확정)

- 화면의 기본 loss = **최근 10초 구간의 원본(raw) loss 비율** = `sum(packets_lost) / sum(packets_expected)`.
- 복구 후 loss(NACK 재전송 이후 남은 유실)는 `packets_lost_unrecovered`로 별도 저장하고, **상세 화면에서만** 원본과 나란히 보여 준다.
- 화면에서 loss 옆에 정의를 툴팁으로 표시한다.

## 5. 저장소

스키마 초안은 같이 전달되는 두 파일이다.

- `edge_schema.sql` — edge 로컬 DB
- `origin_schema.sql` — origin DB

### 5.1 접근 계층 (확정)

DB 접근은 아래 형태의 함수 뒤에 둔다. 화면과 API 코드는 SQL을 직접 쓰지 않는다.

- 쓰기: "정규화된 샘플 묶음을 저장한다" 하나로 통일. 수집기는 이 함수만 호출한다.
- 읽기: 화면 목적별 함수. 예) `getServerSeries`, `getWorkerSeries`, `getRoomSummary`, `getPipeSeries`, `getViewerList`, `getViewerSeries`, `getAlertHistory`.
- 시간 구간 집계, 압축, 보관 기간 정리처럼 DB마다 방식이 다른 부분은 DB별 구현 안에 둔다.
- 대시보드 프런트엔드는 DB를 직접 읽지 않고 API를 거친다.

### 5.2 스키마 확인 필요 사항

- `viewer_sample.packets_lost_unrecovered`가 mediasoup에서 실제로 얻을 수 있는 값인지 먼저 확인한다. 얻을 수 없으면 이 컬럼과 상세 화면의 "복구 후 loss" 표시를 제거한다.
- 스키마는 초안이다. 실제 TimescaleDB 인스턴스에서 실행해 보고, 문제가 있으면 고친 뒤 변경 내용을 보고한다.

## 6. 기능 범위

### 6.1 edge 대시보드 화면

공통 레이아웃: 좌측 사이드바(Overview, Workers, Broadcasts, Pipe 수신, Viewers, Alerts), 이 서버 이름 표시, 하단에 origin 대시보드 링크.

| 화면 | 표시 내용 |
|---|---|
| Overview | KPI, pipe loss 추이, viewer loss 추이(중앙값 p50, 상위 5% p95), worker 요약, 방송 표, viewer loss 구간 분포, 상태가 나쁜 viewer 표 |
| Workers | worker별 CPU·메모리 카드와 추이, router 배치, 리소스 표 |
| Broadcasts | 방송 목록, pipe→router→viewer 흐름, 받고 있는 producer, viewer 수 추이, 레이어 분포 |
| Pipe 수신 | loss, RTT, jitter, bitrate 추이, RTP 통계(NACK, PLI), origin 송신 측과 edge 수신 측 비교 |
| Viewers | 필터(전체, loss 5% 이상, 모바일, 방송, 낮은 레이어), 목록(Loss↓, Freeze, RTT, 레이어, 환경, 접속 시간), 선택한 viewer 요약 패널 |
| Viewer 상세 | 개별 viewer 재생 상태. 서버가 본 값과 브라우저가 보고한 값을 구분해 표시. 화면이 열린 동안 2초 갱신 |
| Alerts | 지금 발동 중인 알림, 임계값에 근접한 항목, 24시간 이력, 규칙 표 |

### 6.2 origin 대시보드 화면

| 화면 | 표시 내용 |
|---|---|
| Overview | KPI, 방송 표(broadcaster 수, ingest 상태, viewer 수, 전달 edge 수, viewer loss p50), 연결된 edge 목록(각 항목에 대시보드 "열기 ↗", 새 탭), 서버 자원, viewer loss 분포, 이벤트 |
| Rooms | 방송 목록, broadcaster 카드(송출 중·대기), bitrate 추이, 방송별 edge 수신 측 보고 loss |
| Broadcaster 상세 | 입력 품질 진단, 지표, 타임라인, 추이, 이벤트. 2초 갱신 |
| Connected Edges | edge 표(상태, 마지막 신호, 요약), 방송×edge 매트릭스 |

사이드바의 Workers, Viewers, Alerts 항목은 아직 화면이 없다. edge 대시보드 구조를 재사용할 예정이며, 이번 범위에서는 만들지 않는다 (미정).

### 6.3 알림

- 서버가 주기적으로 규칙을 평가해 `alert_event`에 저장한다. 발동 시 `firing`, 해소 시 `resolved`.
- 규칙은 `warn`과 `crit` 임계값, 유지 시간(window)을 가진다.
- 기본 규칙 예시: pipe loss, worker CPU, viewer loss p50, loss 5% 이상 viewer 비율. 임계값은 시드 데이터로 넣고 UI에서 수정하지 않는다.
- 외부 알림(Slack 등)은 이번 범위에 넣지 않는다. 다만 알림 이벤트 저장 지점에서 훅을 붙일 수 있게 구조를 열어 둔다.
- score 기반 규칙은 만들지 않는다.

### 6.4 죽은 서버 감지

- 죽은 서버는 스스로 알릴 수 없으므로 origin이 판단한다.
- 각 edge는 주기적으로 `edge_heartbeat`를 origin에 보낸다 (push). origin은 마지막 신호 시각이 기준 시간을 넘으면 "신호 끊김"으로 표시한다.
- heartbeat에는 요약 숫자(viewer 수, pipe 수신 loss)만 담는다. 상세 데이터는 보내지 않는다.
- push와 pull 중 최종 방식은 미정이다. 기본은 push로 구현하되 교체하기 쉽게 만든다.

## 7. UI 상태 (확정)

모든 화면에 공통 적용한다. 색만으로 구분하지 말고 **아이콘과 문구를 함께** 쓴다.

1. **로딩:** 카드 모양을 유지한 스켈레톤. 5초가 넘으면 "수집기 응답이 늦습니다"로 바꾼다.
2. **빈 상태:** 방송 0개, viewer 0명, 알림 0건은 각각 다른 문구를 쓴다. 오류가 아니라 정상 상태임이 드러나야 한다.
3. **stale:** 마지막 수신 시각을 "N초 전"으로 표시하고 값은 지우지 않고 흐리게 둔다. 30초 이상이면 노랑, 2분 이상이면 빨강.
4. **부분 실패:** 패널 단위로 상태를 가진다. 한 패널의 실패가 화면 전체를 오류로 만들지 않는다. 합계 값에는 제외된 항목을 표시한다 (예: "w3 제외").
5. **서버 연결 불가:** 마지막으로 성공한 화면을 흐리게 남기고 배너를 올린다. 재시도 간격은 2→4→8초로 늘리다 30초에서 멈춘다. "지금 다시 시도" 버튼을 둔다.
6. **origin에서 본 edge 상태:** 연결됨, 연결됨·품질 경고, 신호 끊김. edge가 끊겨도 "열기 ↗" 링크는 남기고 경고 문구를 붙인다.

## 8. 디자인 참고

디자인 시안은 같이 전달되는 `design/` 폴더에 있다 (`screenshots/`의 캡처를 먼저 보고, 세부 값은 `html/`에서 확인). 시안과 이 문서가 다른 부분은 `design/README.md`에 적어 두었고, **다를 때는 이 문서가 우선**한다. 화면 이름과 역할:

- edge: `A3-EdgeLocal`(Overview), `A3-Workers`, `A3-Broadcasts`, `A3-Pipe`, `A3-Viewers`, `A3-ViewerDetail`, `A3-Alerts`
- origin: `O1-Overview`, `O2-Rooms`, `O3-Broadcaster`, `O4-Edges`
- 공통: `A3-States`(UI 상태, 갱신 정책)

스타일 요점:
- 색: 배경 `#0E1116`, 카드 `#151A21`, 테두리 `#232B35`, 본문 `#E6EAF0`, 보조 `#9AA6B5`, 파랑 `#5AA9FF`, 노랑 `#F5C451`, 빨강 `#FF8F8F`, 초록 `#4ADE9A`.
- 글꼴: IBM Plex Sans, 숫자·ID는 IBM Plex Mono.
- 터치 대상 최소 44px. 상태는 색만으로 구분하지 않는다.
- 시안의 숫자는 모두 샘플 데이터다. 시안에 score와 라이브 지연은 이미 제거되어 있다.

## 9. 범위 밖

인증·권한, 제어 동작, 외부 알림 전송, 다른 서버 데이터의 중앙 집계, edge 상세 데이터를 origin에 복제하는 것.

## 10. 작업 순서 제안

1. 스키마를 실제 TimescaleDB에서 실행해 검증하고 `packets_lost_unrecovered` 수집 가능 여부를 확인한다.
2. 수집 계층(4절)과 DB 접근 함수(5.1절)를 만든다.
3. 알림 평가와 heartbeat(6.3, 6.4절)를 만든다.
4. API를 만든다.
5. edge 대시보드 화면을 시안대로 구현한다.
6. origin 대시보드 화면을 구현한다.
7. UI 상태(7절)를 모든 화면에 적용한다.

각 단계가 끝나면 한 일, 가정한 것, 막힌 것을 짧게 보고한다.

## 11. 미정 항목 요약

- `packets_lost_unrecovered` 수집 가능 여부
- viewer 원본 보관 기간 (기본 48시간)
- heartbeat 방식 (기본 push)
- origin 사이드바의 Workers, Viewers, Alerts 화면 범위
- 기술 스택 (수집기 언어·프레임워크, 프런트엔드 프레임워크) — 별도 지시가 없으면 기존 mediasoup 서버 코드의 언어에 맞추되 선택 이유를 보고한다
