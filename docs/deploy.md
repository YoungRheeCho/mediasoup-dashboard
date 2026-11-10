# 배포 가이드 (k8s)

원본 매니페스트(`qos/network/mediasoup-*.yaml`)와 mediasoup 코드는 수정하지 않는다.
`deploy/k8s/{edge,origin}`의 kustomize overlay가 원본을 참조해서 아래를 더한다.

| 컨테이너 | 하는 일 |
|---|---|
| `mediasoup-server` (원본) | `NODE_OPTIONS=--require /dashboard-hook/msdash-hook.cjs` + 훅 ConfigMap·소켓 볼륨만 추가 |
| `msdash` (새로) | 대시보드 사이드카: 수집기·알림·heartbeat·API·화면, 포트 18080 |
| `msdash-db` (새로) | TimescaleDB, 127.0.0.1:55432 (노드 밖으로 안 열림), 데이터는 노드의 `/var/lib/msdash/{edge,origin}` |

> 적용하면 Deployment가 바뀌어 **mediasoup Pod가 재시작된다. 방송이 없는 시간에 적용한다.**

---

## 1. 이미지 빌드·푸시

```bash
cd mediasoup-dashboard
docker build -t ghcr.io/<계정>/mediasoup-dashboard:0.1.0 .
docker push ghcr.io/<계정>/mediasoup-dashboard:0.1.0
```

private 레지스트리면 기존 `regcred` 시크릿으로 받을 수 있는 곳에 올린다 (원본 Pod가 이미 `imagePullSecrets: regcred`를 쓴다).
훅(`hook/msdash-hook.cjs`)은 이미지가 아니라 ConfigMap으로 들어가므로 따로 빌드하지 않는다.

## 2. overlay 수정 (3곳)

| 파일 | 항목 | 값 |
|---|---|---|
| `deploy/k8s/edge/kustomization.yaml`, `origin/kustomization.yaml` | `images.newName`, `newTag` | 1에서 올린 이미지 |
| `deploy/k8s/edge/patch.yaml` | `MSDASH_ORIGIN_URL` | `http://<origin 노드 IP>:18080` |
| 두 `kustomization.yaml` | `resources` 경로 | 원본 yaml 위치. 기본값은 `mediasoup-dashboard`와 `qos`가 같은 폴더에 있다고 가정 |

## 3. DB 비밀번호 Secret

```bash
kubectl -n qos create secret generic msdash-db --from-literal=password='<임의의 긴 문자열>'
```

## 4. 미리 보기

원본 yaml이 overlay 디렉터리 밖에 있어 `--load-restrictor` 옵션이 필요하다.

```bash
kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s/origin | kubectl diff -f -
kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s/edge   | kubectl diff -f -
```

diff에 원본 컨테이너가 바뀌는 부분은 `mediasoup-server`의 env 2개와 volumeMounts 2개뿐이어야 한다.

## 5. 적용 (origin 먼저, edge 다음)

```bash
kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s/origin | kubectl apply -f -
kubectl -n qos rollout status deploy/mediasoup-origin

kubectl kustomize --load-restrictor=LoadRestrictionsNone deploy/k8s/edge | kubectl apply -f -
kubectl -n qos rollout status deploy/mediasoup-edge
```

## 6. 확인

```bash
kubectl -n qos get pods -o wide                      # 컨테이너 4/4 READY
POD=$(kubectl -n qos get pod -l app=mediasoup-edge -o name | head -1)

kubectl -n qos logs $POD -c mediasoup-server | grep msdash-hook
#   [msdash-hook] enabled [pid:…, mediasoup:3.x, path:…]
#   [msdash-hook] listening on /var/run/msdash/hook.sock
kubectl -n qos logs $POD -c msdash | tail
#   listening on http://0.0.0.0:18080 / "collection failed"가 반복되지 않아야 한다

curl http://<edge 노드 IP>:18080/api/health          # collector.ok=true, source=hook
curl http://<origin 노드 IP>:18080/api/origin/edges  # 10초쯤 뒤 edge가 등록된다
```

브라우저: `http://<origin 노드 IP>:18080` (Connected Edges에서 각 edge "열기 ↗"), `http://<edge 노드 IP>:18080`.
`hostNetwork`라 노드 IP로 바로 열린다. **인증이 없으므로 18080 포트는 내부망에서만 열리도록 방화벽·보안그룹을 설정한다** (`/api/liveness`는 DB에 쓴다).

## 7. 되돌리기

```bash
kubectl apply -f qos/network/mediasoup-edge.yaml     # 원본으로 다시 적용하면 추가한 컨테이너·env가 빠진다
kubectl apply -f qos/network/mediasoup-origin.yaml
kubectl -n qos get configmap | grep msdash-hook      # 남은 ConfigMap 삭제 (edge·origin이 같은 이름을 공유)
kubectl -n qos delete configmap msdash-hook-<해시>
kubectl -n qos delete secret msdash-db
```

이력 데이터는 각 노드의 `/var/lib/msdash/`에 남는다. 필요 없으면 노드에서 지운다.

## 8. 자주 바꾸는 설정 (`msdash` 컨테이너 env)

| env | 기본값 | 설명 |
|---|---|---|
| `MSDASH_COLLECT_INTERVAL_MS` | 1000 | 수집 주기 (RTCP Receiver Report 주기가 약 1초라 더 줄여도 loss·RTT는 같다) |
| `MSDASH_DB_WRITE_INTERVAL_MS` | 10000 | DB 기록·알림 평가 주기. 1초 수집 묶음을 합쳐서 쓴다 (`server/src/db/downsample.ts`) |
| `MSDASH_HOOK_SPREAD_MS` | 수집 주기의 60% | 훅이 getStats 호출을 이 시간 동안 고르게 나눠 보낸다. 0이면 한꺼번에 (예전 동작) |
| `MSDASH_HOOK_TIMEOUT_MS` | max(3000, 수집 주기×3) | 훅 응답 대기 시간 |
| `NODE_NAME` | — | 이 Pod의 노드 (Downward API `spec.nodeName`). 통합 3D 화면의 노드 묶음 |
| `MSDASH_K8S_DISCOVERY` (origin) | 0 | 1이면 k8s API로 노드·Pod 목록 조회. `deploy/k8s/origin/rbac.yaml`과 `serviceAccountName` 필요 |
| `MSDASH_K8S_EDGE_SELECTOR` / `_ORIGIN_SELECTOR` (origin) | `app=mediasoup-edge` / `app=mediasoup-origin` | 조회할 Pod 라벨 |
| `MSDASH_RETENTION_VIEWER_HOURS` / `_RAW_DAYS` / `_AGG_DAYS` | 48 / 7 / 14 | 보관 기간 (재시작 시 적용) |
| `MSDASH_HEARTBEAT_INTERVAL_MS` | 1000 | edge → origin 신호 주기. 통합 3D 화면의 실시간 값(시청자 목록 포함)이 함께 간다. origin DB에는 10초마다만 기록 |
| `MSDASH_LIVENESS_MODE` | push | `pull`이면 origin이 edge에 묻는다 (양쪽 같게) |
| `MSDASH_NIC_CAPACITY_BPS` | 1e9 | NIC 용량 표시용 (Overview "송신 트래픽") |
| `MSDASH_MOCK` | 1 | 0이면 mock 값을 채우지 않는다 (해당 칸은 "—") |
| `MSDASH_PIPE_IP` (edge) | `SERVER_IP` | origin이 보는 이 edge의 pipe IP. 다르면 방송↔edge 연결이 "미확인"으로 남는다 |
| `MSDASH_HOOK_CONCURRENCY` (mediasoup-server) | 6 | 훅의 getStats 동시 호출 수 |

## 9. 문제 해결

| 증상 | 확인 |
|---|---|
| `mediasoup-server` 로그에 `[msdash-hook]`가 없다 | `kubectl exec … -c mediasoup-server -- env | grep NODE_OPTIONS`. 서버를 `npm start`가 아닌 다른 이름으로 띄우면 `MSDASH_HOOK_MATCH`에 실행 파일 이름을 넣는다 |
| `no mediasoup worker observed after 30s` | 훅이 서버와 다른 mediasoup 인스턴스를 잡았다 (H3). 로그의 `path:`가 서버의 mediasoup 경로인지 확인 |
| 사이드카 `connect ENOENT /var/run/msdash/hook.sock` | 훅이 안 켜졌거나 소켓 볼륨이 두 컨테이너에 같은 경로로 붙지 않았다 |
| 사이드카 `EACCES` | 소켓 권한. 최신 훅은 소켓을 0666으로 만든다 (ConfigMap이 갱신됐는지 확인) |
| `database not ready`가 반복 | `kubectl logs … -c msdash-db`. 노드에서 55432 포트 충돌, `/var/lib/msdash` 권한 |
| `mediasoup-server`가 OOMKilled | 원본 limit이 200Mi로 작다 (H13). worker 프로세스도 같은 limit에 들어간다. overlay patch에서 `mediasoup-server` resources를 늘린다 |
| origin에 edge가 안 나온다 | edge `MSDASH_ORIGIN_URL`, 노드 간 18080 통신, edge `msdash` 로그의 `heartbeat … failed` |
| 화면에 SIMULATED가 보인다 | `MSDASH_MEDIASOUP_SOURCE`가 `sim`으로 설정됐다. 기본값(hook)으로 둔다 |
