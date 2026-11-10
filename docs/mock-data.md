# MOCK(예시 값)으로 채운 데이터 목록

작성: 2026-11-10. 실제로 측정하지 못해 **예시 값으로 채운 항목**을 한곳에 모은다.
화면에는 `MOCK` 배지가 붙고, 알림 평가에는 쓰지 않는다. 실제 값으로 바꾸면 이 표에서 지운다.

- 통합 3D 화면(origin `/`)의 MOCK 목록은 API 응답 `mockFields`로도 내려간다 (`server/src/central/central.ts`의 `CENTRAL_MOCK_FIELDS`).
- 기존 화면의 MOCK 목록은 `server/src/mock/index.ts`의 `MOCK_FIELDS`, 설계 배경은 [collection-design.md](collection-design.md) 4절 M1~M11.

## 1. 통합 3D 화면에서 새로 생긴 MOCK (C1~C3)

| # | 항목 | 화면 위치 | 지금 값을 만드는 방법 | 왜 MOCK인가 | 실제로 바꾸려면 |
|---|---|---|---|---|---|
| C1 | **LATE 비율** (시청자별 %) | 시청자 라벨, 시청자 목록 정렬·막대, 상세 패널 그래프, "LATE 경고 N명", 모니터 주황색 경고 | viewer id로 정한 기본값(0~0.6%) + 최근 5초 loss × 1.3, 최대 5% (`mockLatePct`) | 지표 정의가 정해지지 않음 (늦게 도착한 패킷 비율인지 등) | 정의를 정한 뒤 edge 수집기(`normalizeEdge.ts`) 또는 브라우저 보고(`reportClientStats`)에서 계산해 live 값에 넣고 `mockLatePct`를 지운다 |
| C1' | LATE 경고 기준 2% | 위와 같음 | 화면 상수 `WARN_LATE=2` (`web/central.html`) | LATE 자체가 예시라 기준도 예시 | C1과 함께 알림 규칙(`alert_rule`)으로 옮긴다 |
| C2 | **qdisc drop** (노드별 /s) | 노드 카드 그래프·배지, 3D의 주황 불꽃 | origin 메모리에서 대부분 0이고 가끔 몇 초 튀는 난수 (`#stepDrop`) | 수집 방식(노드의 `tc -s qdisc` 읽기 / Prometheus `node_qdisc_drops_total`)이 정해지지 않음 | 수집 방식을 정한 뒤 노드별 값을 live에 넣고 `#stepDrop`을 지운다. Prometheus면 `sum(rate(node_qdisc_drops_total[1m]))` (node_exporter `--collector.qdisc` 필요) |
| C3 | **로드 밸런싱 배정 사유** | 시청자 입장 시 origin 위 안내 "배정 전 시청자 N명 · 배정 사유 MOCK" | 사유 없이 배정 전 시청자 수만 표시 | 실제 배정 규칙(로드 밸런서)을 모름. **어느 edge로 갔는지는 실제 값** | 로드 밸런서가 사유를 알려 주면(예: 응답 헤더, 로그) 안내 문구에 넣는다 |

## 2. 기존부터 있던 MOCK (서버·클라이언트 코드 수정이 필요한 값)

| # | 항목 | 통합 3D 화면에서 | 언제 실제 값이 되나 |
|---|---|---|---|
| M1 | 시청자 이름·peerId·브라우저 | 이름 옆 `MOCK` (해당 시청자만) | mediasoup-demo 서버가 transport `appData`에 `peerId`를 넣으면 (한 줄 수정) |
| M2 | freeze 횟수·시간, fps, jitter buffer, dropped frames, 해상도·재생 상태 | 상세 패널 Freeze·fps 옆 `MOCK` (보고 없는 시청자만). **freeze 표시(연결선 사라짐·빨간 깜빡임)는 실제 보고가 있는 시청자만** 한다(mock 값으로는 표시하지 않음). 판단: 이번 수집 구간에 freeze 횟수 증가 또는 fps < 1 → 2초 유지 | 시청자 브라우저가 `reportClientStats`를 보내면 그 시청자는 실제 값. `fec-merged` 브랜치 클라이언트에 이미 있음. Safari·Firefox는 freeze 값을 주지 않는다 |
| M3 | 네트워크 종류(wifi/LTE) | 쓰지 않음 (화면에서 숨김) | 클라이언트가 `navigator.connection`을 보고에 담으면 (Chrome 계열만) |
| M4 | user agent 원문, 모바일/PC 구분 | 쓰지 않음 | 서버가 WS 헤더의 user-agent를 저장하면 |
| M5 | 접속 종료 사유 | 쓰지 않음 | 서버가 Peer 종료 사유를 내보내면 (`transport_failed`만 지금도 실제) |
| M8 | 송출자 fps·해상도·인코더 정보 | 쓰지 않음 (송출자 수는 실제) | 송출 브라우저가 outbound-rtp 값을 보고하면 |
| M10 | Pipe 화면 origin 측 비교값 | 쓰지 않음 (기존 화면에서도 미구현) | heartbeat 응답에 origin 송신 통계를 담으면 |

## 3. 실제 값이지만 이름과 뜻이 조금 다른 것 (MOCK 아님, 해석 주의)

| 3D 표현 | 데이터 | 비고 |
|---|---|---|
| 연결선 빛 입자 양·속도 | 시청자 수신 비트레이트 (서버 실측, 1초) | 150 kbps 이하 1개 ~ 4 Mbps 이상 6개, 로그 눈금 |
| 모니터 화질 (선명 / 흐림 / 모자이크) | 수신 레이어 L2 / L1 / L0 (서버 실측) | |
| 연결선·빛 사라짐 + 시청자 빨간 깜빡임 + 멈춘 화면 | freeze (브라우저 보고) | 위 M2 참고. 보고 주기가 5초면 늦게 보인다 → 클라이언트 보고 주기 1초 권장 |

| 항목 | 화면 표기 | 실제로 재는 것 |
|---|---|---|
| 중계 서버 CPU | Worker CPU 합 | mediasoup worker 프로세스 CPU 합 (코어 1개 = 100%, worker가 여러 개면 100%를 넘음). 컨테이너 전체 CPU(cgroup)가 아님 |
| Node CPU | Node CPU | 그 노드에서 도는 대시보드 컨테이너가 읽은 `/proc/stat` (노드 전체). 같은 노드의 여러 Pod 값의 평균 |
| 송출자 수 | 송출자 N명 | origin에서 이번 1초 동안 비트레이트가 0보다 큰 broadcaster 수 |
| 시청자 loss | Loss (최근 5초) | 시청자가 보낸 RTCP RR 기반 loss의 최근 5초 합 (복구 후 loss에 가까움, M9) |
| 그래프 30분 이력 | 30분 전 ~ 현재 | origin 대시보드 메모리에만 있다. origin 대시보드를 재시작하면 그때부터 다시 쌓인다 |
| 노드 목록 | 노드 이름·개수 | k8s 조회(`MSDASH_K8S_DISCOVERY=1`)가 되면 클러스터의 노드 전체, 안 되면 edge·origin이 알려 준 `NODE_NAME`만 |

## 4. MOCK을 끄는 방법

`MSDASH_MOCK=0`이면 M1~M8 칸은 비워 둔다("—"). C1~C3은 통합 화면 구성 요소라 지금은 끌 수 없고 항상 `MOCK` 배지로 표시된다.
