# 수집 방식 설계 메모 — 사전 로드 훅, mock 정책, 추후 구현 고려 사항

작성일: 2026-10-19
대상 코드: edge = `mediasoup-demo` `deadline` 브랜치 (`6e72dd3`), origin = `integrated` 브랜치. 배포 = k8s (`qos/network/mediasoup-edge.yaml`, `mediasoup-origin.yaml`).

## 0. 원칙

- 기존 mediasoup 코드(`qos/network/mediasoup-demo`, `qos/network/mediasoup`)는 **수정하지 않는다.** 실행 중 기존 동작을 바꾸는 몽키패치도 수정으로 본다.
- 기존 코드를 고쳐야만 얻을 수 있는 데이터는 **mock으로 명목상 구현**하고 나중으로 미룬다 (3절의 M 번호).
- mock 값은 화면에 아이콘과 문구로 `MOCK` 표시를 붙이고, **알림 평가에서 제외**한다.
- 수집 출처마다 인터페이스 하나에 `real` / `mock` 구현을 두고 설정으로 고른다. 정규화 → DB → 알림 → API → 화면 경로는 처음부터 실제 코드로 만든다.

## 1. 사전 로드 훅이란

Node는 `--require <파일>` 옵션(또는 환경 변수 `NODE_OPTIONS`)을 주면 **본 프로그램보다 먼저 그 파일을 같은 프로세스에서 실행**한다.

```
mediasoup-server 컨테이너
┌───────────────────────────────────────────┐
│ node 프로세스                               │
│  ① hook.js 먼저 실행 (--require)            │
│     └ mediasoup.observer 구독               │
│  ② 서버 lib/index.js 실행 (코드 변경 없음)   │
│     └ createWorker → observer가 알려 줌      │
│  hook: getStats() 호출 → 유닉스 소켓으로 응답 │
└──────────────────────┬────────────────────┘
                       │ (공유 emptyDir 볼륨 안의 소켓)
┌──────────────────────┴────────────────────┐
│ dashboard 사이드카: 정규화 → DB → 알림 → API │
└───────────────────────────────────────────┘
```

- **동작 원리:** Node는 모듈을 한 번만 불러와 같은 객체를 공유한다. 훅이 먼저 `require('mediasoup')`를 해 두면 서버가 쓰는 것과 같은 인스턴스를 잡는다. 이 인스턴스의 `mediasoup.observer`가 worker·router·transport·producer·consumer의 생성과 종료를 알려 준다. 서버의 `TerminalServer.ts`도 같은 방식으로 객체를 추적한다.
- **할 수 있는 것:** 객체 목록 추적, `getStats()`, `getResourceUsage()`, `appData`와 공개 getter 읽기, 전역 `rooms`의 `serialize()` 읽기.
- **할 수 없는 것:** `#` private 필드 접근(viewer와 transport 연결, shard 배정 등), 서버가 받지 않는 데이터(브라우저 통계) 얻기.
- **확인한 사실:** 서버는 CommonJS로 빌드되고(`lib/index.js`, package.json에 `type` 없음), mediasoup도 CJS(`node/lib/index.js`)라 `--require`로 붙을 수 있다.
- **viewer 식별:** viewer 한 명은 consumer용 WebRtcTransport를 하나 쓴다. 그래서 **transport id를 임시 viewer id로 쓰면** loss, RTT, bitrate, 레이어를 실제 값으로 받을 수 있다. 이 transport가 어느 peerId(이름, 기기)인지만 mock으로 둔다 (M1).

## 2. 배포 매니페스트 변경 (원본 yaml은 수정하지 않음)

같은 Pod 안에 사이드카를 두려면, 클러스터에 올라가는 Deployment에 아래가 들어가야 한다.

- `mediasoup-server` 컨테이너: env `NODE_OPTIONS=--require /dashboard-hook/hook.js`, 훅 파일 볼륨, 소켓 공유용 emptyDir 볼륨
- 컨테이너 추가: `mediasoup-dashboard`(수집기·API·화면), `timescaledb`

원본 `mediasoup-edge.yaml`, `mediasoup-origin.yaml`은 그대로 둔다. 대신 대시보드 프로젝트에 **kustomize overlay**(`mediasoup-dashboard/deploy/k8s/`)를 두고, 원본을 base로 참조하는 patch로 위 항목을 더한다. 적용은 `kubectl apply -k`로 한다.

- 장점: 원본 파일은 바뀌지 않는다. overlay를 적용하지 않으면 지금과 똑같이 배포된다. 되돌리기는 원본으로 다시 apply하면 된다.
- 주의: 적용하면 클러스터의 Deployment가 바뀌므로 Pod가 재시작된다. 방송 중에는 적용하지 않는다.

## 3. 훅 구현 시 반드시 고려할 점

| # | 고려할 점 | 이유 | 추천 |
|---|---|---|---|
| H1 | 서버를 죽이지 않기 | 훅은 SFU 시그널링과 같은 프로세스·이벤트 루프에서 돈다. 예외 하나가 나면 방송 전체가 끊긴다. | 모든 콜백을 try/catch로 감싼다. 소켓 오류는 로그만 남기고 삼킨다. 초기화가 실패하면 수집만 끄고 서버는 그대로 둔다. |
| H2 | NODE_OPTIONS는 하위 프로세스에도 상속됨 | `CMD ["npm","start"]` → npm → npx → node 순으로 실행되는데, npm·npx도 Node라서 훅을 각각 불러온다. | 훅 첫머리에서 `process.argv`에 `mediasoup-demo-server`가 있을 때만 활성화하고, 아니면 즉시 return한다. |
| H3 | 같은 mediasoup 인스턴스 잡기 | mediasoup가 `file:../../mediasoup` 로컬 의존성이라, 다른 경로로 resolve하면 별개 인스턴스가 되어 이벤트가 오지 않는다. | `require.resolve('mediasoup', { paths: [서버 디렉터리] })`를 쓴다. 시작할 때 `mediasoup.version`을 로그로 남기고, worker가 0개면 경고한다. |
| H4 | getStats 부하 | worker IPC 호출이다. viewer 300명 × consumer 수가 10초마다 몰리면 이벤트 루프가 지연된다. | 동시성 4~8, 수집 1회 시간 상한, 한 주기를 넘기면 다음 주기를 건너뛴다(AGENT_TASK 4.3절). `monitorEventLoopDelay`도 함께 내보낸다. **남은 한계(순간 몰림, viewer 비례)와 개선안은 handover.md 2.5절.** |
| H5 | 훅과 사이드카 사이 통신 | `hostNetwork: true`라서 TCP 포트를 열면 호스트 전체에 노출된다. | 공유 emptyDir 안의 유닉스 소켓을 쓴다. 서버 디렉터리가 아니라 별도 마운트 경로에 둔다. 사이드카가 pull한다. |
| H6 | 메모리 누수 | 객체마다 리스너를 달기 때문에, close 때 정리하지 않으면 장시간 운영 중 메모리가 는다. | `observer.on('close')`에서 맵과 직전 누적값 캐시를 지운다. 맵 크기를 지표로 내보낸다. |
| H7 | 포크 mediasoup와 stats 필드 호환 | `network/mediasoup`는 포크라서 필드 이름이나 의미가 원본과 다를 수 있다. | 정규화를 한 모듈에 모은다. 필드가 없으면 0이 아니라 NULL로 둔다. 첫 수집 때 실제 stats를 덤프해 검증한다. |
| H8 | 재시작과 누적값 리셋 | 재시작하면 누적 카운터가 줄고 worker pid가 바뀐다. | 증가분이 음수면 그 구간은 버린다. worker는 pid가 아니라 `appData.idx`로 식별한다. |
| H9 | 보안 | 대시보드는 인증이 없는데 hostNetwork 때문에 노드 IP로 바로 열린다. | 포트를 env로 받고, 접근 제한은 노드 방화벽이나 보안그룹으로 한다(NetworkPolicy는 hostNetwork Pod에 잘 안 먹힌다). |
| H10 | TimescaleDB 사이드카 | hostNetwork라서 5432 포트가 겹칠 수 있다. emptyDir에 저장하면 Pod가 재시작할 때 이력이 사라진다. | 포트는 env로 바꿀 수 있게 한다. 저장소는 PVC나 hostPath를 쓴다. 메모리 상한을 둔다. |
| H11 | edge 식별 | Pod 이름은 재시작하면 바뀐다. edge는 노드당 하나다(podAntiAffinity). | Downward API의 `spec.nodeName`을 `edge_id`로 쓴다. `dashboard_url`은 `status.hostIP`와 대시보드 포트로 만든다. |
| H12 | mock에서 실제로 교체 | 교체할 때 화면이나 DB 코드를 건드리지 않아야 한다. | 출처마다 real/mock 구현을 둔다. mock 위치에는 이 문서의 M 번호를 주석으로 단다. |
| H13 | **mediasoup-server 자원 한도** | 현재 매니페스트의 한도가 `cpu: 400m`, `memory: 200Mi`로 작다. 훅의 메모리·CPU가 이 한도를 함께 쓰므로 OOMKill 위험이 있다. | 훅은 캐시를 최소화한다(직전 누적값과 최근 1회 스냅숏만). DB 기록과 집계는 사이드카가 한다. 부하 테스트에서 한도 대비 사용량을 측정한다. |
| H14 | **Pod 전체에 걸린 seccomp 프로필** | `securityContext.seccompProfile`(`allow-io-uring.json`)이 Pod 단위라 사이드카와 TimescaleDB에도 적용된다. 허용되지 않은 syscall이 있으면 DB가 뜨지 않을 수 있다. | 사이드카 컨테이너에 컨테이너 단위 `securityContext.seccompProfile: RuntimeDefault`를 지정해 Pod 설정을 덮어쓴다. |

## 4. mock 항목과 나중에 실제로 구현하는 방법

모두 기존 코드를 고쳐야 얻을 수 있는 항목이다. 코드 수정이 허용될 때를 위한 가장 작은 변경 방법을 함께 적는다.

| # | 항목 (mock) | 왜 지금은 못 얻나 | 나중에 추천하는 변경 |
|---|---|---|---|
| M1 | viewer의 peerId·이름·기기 (지표는 transport 기준으로 실제 수집) | consumer의 `appData.peerId`에는 broadcaster id가 들어 있고, transport와 Peer의 연결은 `Peer.#transports`에만 있다. | `Peer.ts`에서 transport를 만들 때 `appData`에 `peerId`를 넣는다(한 줄). 훅이 `room.serialize()`의 device와 조인한다. |
| M2 | 브라우저 보고값 (freeze, 디코딩 fps, jitter buffer, dropped) | 클라이언트의 `startVideoStatsMonitor`가 계산하지만 Redux와 console로만 보낸다. | 클라이언트가 5~10초마다 모아서 protoo `notify('clientStats')`로 보낸다. `Peer.ts`가 받아 이벤트로 내보내고 훅이 구독한다. freeze는 Chrome inbound-rtp의 `freezeCount`, `totalFreezesDuration`을 쓴다. |
| M3 | network_type | 브라우저 `navigator.connection`에만 있다. | M2 보고에 함께 담는다. |
| M4 | user_agent 원문 | `WsServer`가 헤더를 저장하지 않고, bowser로 파싱한 `device`만 남는다. | WS 연결을 받을 때 `req.headers['user-agent']`를 Peer에 넘겨 `serialize()`에 포함한다. 그 전까지 `device_class`는 실제 `device.flag`·`name`으로 추정한다. |
| M5 | disconnect_reason | Peer가 닫힐 때 사유를 내보내지 않는다. | `Peer`의 `closed` 이벤트에 사유를 담는다(client_closed, transport_failed, timeout). |
| M6 | viewer의 shard 배정 | `#peerConsumerRouterIndex`가 private이다. | router를 만들 때 `appData: { roomId, role, shardIdx }`를 준다. 방송별 shard 목록은 지금도 같은 producer id를 가진 router를 찾는 방식으로 실제 추정한다(`pipeToRouter`는 같은 producer id를 쓴다). |
| M7 | origin의 방송별 edge 전달 관계 | `Room.origin`의 pipe 상태가 private이다. | origin이 pipe transport를 만들 때 `appData: { edgeId, roomId }`를 준다. 그 전까지는 원격 IP와 `REMOTE_PIPE_TARGETS`를 대조해 추정하고, 실패하면 mock으로 둔다. |
| M8 | broadcaster fps | mediasoup producer stats에 fps 항목이 없다(포크 소스에서 확인). | broadcaster 클라이언트가 outbound-rtp `framesPerSecond`를 M2 방식으로 보고한다. worker C++ 수정은 비추천. |
| M9 | 원본 loss(복구 전)와 복구 후 loss 구분 | 서버가 아는 viewer loss는 RTCP RR 기반이라 이미 복구 후에 가깝다(정의 문제). | 기본 loss를 "RR 기반 loss"로 정의하고 툴팁에 명시한다. 복구 전 loss는 `nackCount`·`packetsRetransmitted` 기반 근사치로 상세 화면에만 표시한다. AGENT_TASK 4.4절을 수정해야 한다. |
| M10 | Pipe 화면의 origin 송신 측 비교값 | edge는 자기 데이터만 갖는다(설계 결정 필요). `design/README.md`에 따라 **mock도 넣지 않고 패널 자체를 구현하지 않는다** (보고 항목). | heartbeat **응답**에 origin이 그 edge로 보낸 송신 통계(origin `pipe_send_sample`)를 담아 돌려준다. push 구조를 유지할 수 있다. |
| M11 | (장기) 훅 자체 제거 | 훅은 우회 수단이라 서버 내부 구조가 바뀌면 깨질 수 있다. | 서버에 공식 관측 지점을 둔다: `Server.observer`에 `new-peer`, `peer-closed` 이벤트를 추가하고 M1·M5·M6 appData를 정리한다. 그러면 훅은 이벤트만 구독하는 몇십 줄로 줄어든다. |

## 5. 2단계 검증 결과 (2026-10-20)

시험 환경: WSL Ubuntu, Node 22.22.1, mediasoup 3.19.14 (npm prebuilt, 포크와 같은 버전대), TimescaleDB 2.17.2-pg16.
하네스(`mediasoup-demo-server`라는 entry 이름으로 실행)에 `NODE_OPTIONS=--require hook/msdash-hook.cjs`로 훅을 붙이고,
plain broadcaster(3% 유실) → 원격 pipe → edge producer router → pipeToRouter → consumer shard → viewer 구성을 실제로 만들어 확인했다.

확인된 것
- 훅이 서버 entry에서만 켜지고, 같은 `NODE_OPTIONS`를 받은 npm에서는 켜지지 않는다 (H2).
- 훅이 서버와 같은 mediasoup 인스턴스를 잡아 worker/router/transport/producer/consumer를 모두 추적한다 (H3).
- 훅 소켓이 없으면 사이드카는 멈추지 않고 `collector_sample.hook_ok=false`를 기록한다.
- 수신 측(pipe producer, broadcaster producer)의 `packetsLost`는 복구 전 원본 loss, `packetsRepaired`는 복구분이다
  (worker `RtpStreamRecv.cpp`: RTX 복구분은 media 카운터에 넣지 않는다). 수신 stream의 `packetCount`는 복구분을 포함하므로
  `expected = packetCount − packetsRepaired + packetsLost`로 계산한다.
- jitter는 RTP timestamp 단위라 clock rate로 ms 변환한다.
- pipe 수신 RTT는 실제로 값이 나온다 (0이면 측정 안 됨으로 보고 NULL).
- shard router → 방송 연결(같은 producer id 추정)과 origin의 PipeTransport 원격 IP → edge 추정(M7)이 동작한다.
- 이벤트 루프 지연: `monitorEventLoopDelay` 기록값에는 샘플링 간격(20ms)이 포함되어 있어 빼고 보고한다.

주의할 해석
- **edge의 pipe 수신 loss에는 broadcaster → origin 구간 유실이 섞인다.** pipe는 원래 seq 번호를 그대로 전달하므로
  origin이 받지 못한 패킷은 edge에서도 유실로 잡힌다. 화면 툴팁에 "origin 입력 유실 포함"을 적고,
  origin 대시보드의 broadcaster loss와 비교해서 보도록 안내한다. origin의 `pipe_send_sample.packets_lost`(edge RR)도 같다.
- 같은 worker 안에서는 producer id가 유일해야 한다. 실제 배포(origin·edge 별도 서버)에서는 문제없다.

실제 브라우저 viewer(DTLS 연결) 구간은 시험하지 못했다. viewer 쪽 RR 기반 loss·RTT는 실제 클라이언트로 확인이 필요하다.

## 6. 3단계: 알림 평가와 생존 신호 (2026-10-20)

알림 (`server/src/alerts/`)
- 수집 묶음마다 서버 값으로 지표를 만들고(`metrics.ts`) 규칙을 평가한다(`evaluator.ts`). mock 값·브라우저 보고값은 지표에 넣지 않는다.
- 발동: 임계값을 `window_seconds` 동안 계속 넘음. 해소: 경고 아래로 `window_seconds` 동안 머묾. 등급 상승(warn→crit)은 즉시 다시 발동하고, 하강은 crit 아래로 window 동안 머문 뒤.
- 대상이 사라지면(방송 종료 등) window 뒤 해소. 사이드카 재시작 시 발동 중이던 알림을 이어받아 중복 발동하지 않는다.
- 지표 단위: pipe loss·viewer p50·나쁜 viewer 비율은 방송별, CPU는 worker별, broadcaster loss는 broadcaster별, edge 수신 측 보고 loss는 방송×edge별.
- 외부 알림 훅: `AlertSink` 인터페이스. 지금은 로그(`LogSink`)만 붙어 있다.
- "임계값 근접"은 경고 임계값의 80% 이상 (`NEAR_RATIO`).

생존 신호 (`server/src/liveness/`)
- 기본 push: edge가 `MSDASH_HEARTBEAT_INTERVAL_MS`(기본 10초)마다 origin `POST /api/liveness`. 요약 숫자(viewer 수, 신호 사이 pipe 수신 lost/expected delta, 자체 점검 결과)와 dashboard URL·pipe IP만 보낸다.
- 전송 실패 시 delta는 다음 신호에 합쳐진다. RTT는 직전 신호 왕복 시간 (origin은 DB 기록 전에 응답).
- origin은 신호로 edge를 자동 등록하고, pipe IP를 PipeTransport 원격 IP와 대조한다 (M7, 설정 `MSDASH_EDGE_TARGETS`는 보조).
- 상태: 신호 나이 ≥ `edge_signal_age` warn(30초) → 신호 끊김, 자체 점검 실패 또는 수신 loss ≥ `pipe_send_loss` warn → 연결됨·품질 경고, 그 외 연결됨.
- pull로 바꾸기: `MSDASH_LIVENESS_MODE=pull`. origin이 알려진 edge의 `GET /api/liveness`를 조회한다. push 모드에서 edge는 이 경로를 열지 않는다 (delta를 두 곳에서 가져가지 않도록).
- 인증 없음(읽기 전용 데모 범위). 다만 `/api/liveness`는 DB에 쓰므로 외부 노출 시 접근 제한 필요 (H9).
