# mediasoup 모니터링 대시보드

mediasoup origin·edge 서버마다 붙는 읽기 전용 모니터링 대시보드. mediasoup 코드는 수정하지 않고,
서버 프로세스에 사전 로드되는 **훅**이 통계를 꺼내고 같은 Pod의 **사이드카**가 수집·저장(TimescaleDB)·알림·API·화면을 맡는다.

- 처음 읽을 문서: **[docs/handover.md](docs/handover.md)** — 구현 내용, 미구현·mock 목록, 정해야 할 것, 수정 가이드
- API: [docs/api.md](docs/api.md) · 수집 설계: [docs/collection-design.md](docs/collection-design.md) · UI 상태: [docs/ui-states.md](docs/ui-states.md) · 배포: [docs/deploy.md](docs/deploy.md)
- 원 지시서: [AGENT_TASK.md](AGENT_TASK.md), 디자인 시안: [design/](design/)

```
hook/       mediasoup 서버에 NODE_OPTIONS=--require 로 붙는 훅
server/     사이드카 (Node 22 + TypeScript)
web/        화면 (React + Vite)
db/         스키마·시드 SQL
deploy/     k8s overlay (참고용)
tools/      시험 도구
```

빠른 확인: `curl http://<노드IP>:18080/api/health` → `source: "hook"`, `collector.ok: true`. 화면은 `http://<노드IP>:18080`.

## 이미지 빌드와 Kubernetes 배포

아래 예시는 `qos` 네임스페이스에서 기존 mediasoup 서버 Pod에 대시보드와 TimescaleDB를 함께 실행하는 방식입니다. **기존 mediasoup 소스와 기존 YAML은 수정하지 말고**, 운영 중인 매니페스트를 복사한 새 YAML 또는 별도 overlay에 필요한 설정을 반영하세요. 기존 컨테이너 설정·볼륨·네트워크 설정은 운영 환경에 맞게 유지해야 합니다.

> `design/central-overview-*.html`은 중앙 대시보드의 독립적인 디자인 시안입니다. 아래 Docker 이미지는 현재 구현된 서버별 Origin/Edge 대시보드를 실행하며, 시안의 중앙 화면이나 캔들 차트를 자동으로 포함하지 않습니다.

### 1. 이미지 빌드 및 업로드

프로젝트 루트에서 실행합니다. `1.4.0`은 예시이므로 아직 사용하지 않은 버전으로 바꾸세요.

```bash
git clone https://github.com/YoungRheeCho/mediasoup-dashboard.git
cd mediasoup-dashboard

sudo docker build -t ghcr.io/youngrheecho/mediasoup-dashboard:1.4.0 .
sudo docker push ghcr.io/youngrheecho/mediasoup-dashboard:1.4.0
```

이미지에는 수집기·API·현재 React 화면과 DB 스키마가 포함됩니다. Hook은 이미지에 포함되지 않아 ConfigMap으로 별도 배포합니다. DB 연결 주소와 서버 주소는 빌드할 때 코드에 넣지 않고 아래 환경변수로 지정합니다. 클러스터 노드의 CPU 아키텍처와 빌드된 이미지 아키텍처도 일치해야 합니다.

GHCR의 private 이미지는 Kubernetes에서 접근할 수 있는 `imagePullSecrets`가 필요합니다. 빌드하는 컴퓨터에서 `docker login`한 인증 정보와 Kubernetes의 pull Secret은 별개입니다.

### 2. Hook ConfigMap 준비

프로젝트 루트에서 저장소의 Hook을 사용한다면:

```bash
kubectl create configmap msdash-hook -n qos \
  --from-file=msdash-hook.cjs=hook/msdash-hook.cjs \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl get configmap msdash-hook -n qos
```

Hook이 `~/msdash-hook.cjs`에 있다면 경로는 `--from-file=msdash-hook.cjs=$HOME/msdash-hook.cjs`로 지정합니다. Hook은 Node 프로세스 시작 시 로드되므로 ConfigMap의 내용을 바꾼 경우 mediasoup 서버 프로세스를 다시 시작해야 적용됩니다. ConfigMap이 동일하고 Hook만 바뀌지 않았다면 이미지 빌드마다 갱신할 필요는 없습니다.

### 3. DB Secret 준비

TimescaleDB가 사용할 비밀번호를 Kubernetes Secret `msdash-db`의 `password` 키로 준비합니다. 비밀번호와 실제 Secret YAML은 Git에 올리지 마세요. 이미 Secret이 있다면 새로 만들지 말고 이름과 키를 확인합니다.

```bash
kubectl get secret msdash-db -n qos
```

새로 만들어야 한다면 비밀번호를 안전하게 입력한 후 생성합니다. **기존 DB가 있는 경우 Secret만 바꿔서는 DB에 저장된 비밀번호가 자동으로 변경되지 않습니다.**

```bash
read -rsp 'DB password: ' MSDASH_DB_PASSWORD
echo
kubectl create secret generic msdash-db -n qos \
  --from-literal="password=$MSDASH_DB_PASSWORD"
unset MSDASH_DB_PASSWORD
```

### 4. Kubernetes YAML에 넣을 설정

아래는 전체 Pod YAML이 아닌 **구조 예시**입니다. `spec`은 Pod의 `spec`, Deployment나 StatefulSet에서는 `spec.template.spec`에 해당합니다. 기존 YAML의 `volumes`, `containers`, `imagePullSecrets`에 항목을 합쳐야 하며 동일한 키를 중복해 넣으면 안 됩니다.

```yaml
# Pod spec 또는 spec.template.spec의 일부
imagePullSecrets:
  - name: regcred # private GHCR 사용 시 준비된 Secret 이름

volumes:
  - name: msdash-hook
    configMap:
      name: msdash-hook
  - name: msdash-sock
    emptyDir: {}
  - name: msdash-db
    hostPath:
      path: /var/lib/msdash/edge-0 # 서버마다 별도 경로; 환경에 맞게 변경
      type: DirectoryOrCreate

containers:
  # 기존 mediasoup-server 항목에 env와 volumeMounts를 추가합니다.
  - name: mediasoup-server
    env:
      - name: NODE_OPTIONS
        value: "--require /dashboard-hook/msdash-hook.cjs"
      - name: MSDASH_HOOK_SOCKET
        value: /var/run/msdash/hook.sock
    volumeMounts:
      - name: msdash-hook
        mountPath: /dashboard-hook
        readOnly: true
      - name: msdash-sock
        mountPath: /var/run/msdash

  - name: msdash
    image: ghcr.io/youngrheecho/mediasoup-dashboard:1.4.0
    imagePullPolicy: IfNotPresent
    env:
      - name: MSDASH_MODE
        value: edge # 원본 서버는 origin
      - name: MSDASH_SERVER_ID
        value: edge-0 # 서버별로 유일한 이름으로 변경
      - name: MSDASH_HTTP_PORT
        value: "18080"
      - name: MSDASH_PUBLIC_URL
        value: "http://<이-서버-대시보드-접근주소>:18080"
      - name: MSDASH_ORIGIN_URL # 중계 서버에 설정
        value: "http://<원본-대시보드-접근주소>:18080"
      - name: MSDASH_PIPE_IP # 중계 서버의 실제 pipe IP로 변경
        value: "<중계-서버-pipe-IP>"
      - name: MSDASH_HOOK_SOCKET
        value: /var/run/msdash/hook.sock
      - name: DB_PASSWORD # DATABASE_URL보다 먼저 선언
        valueFrom:
          secretKeyRef:
            name: msdash-db
            key: password
      - name: MSDASH_DATABASE_URL
        value: "postgres://postgres:$(DB_PASSWORD)@127.0.0.1:55432/msdash"
      - name: MSDASH_NIC_CAPACITY_BPS
        value: "1000000000" # 1 Gbps 예시; 실제 환경에 맞게 변경
      - name: MSDASH_MOCK
        value: "1" # 0이면 mock 값을 채우지 않음
    ports:
      - name: dashboard
        containerPort: 18080
        # 필요 시 별도 Service 또는 충돌하지 않는 hostPort 설정
    readinessProbe:
      httpGet:
        path: /api/health
        port: 18080
      periodSeconds: 10
      failureThreshold: 6
    volumeMounts:
      - name: msdash-sock
        mountPath: /var/run/msdash

  - name: msdash-db
    image: timescale/timescaledb:2.17.2-pg16
    args: ["-c", "port=55432", "-c", "listen_addresses=127.0.0.1"]
    env:
      - name: POSTGRES_PASSWORD
        valueFrom:
          secretKeyRef:
            name: msdash-db
            key: password
      - name: POSTGRES_DB
        value: msdash
      - name: PGDATA
        value: /var/lib/postgresql/data/pgdata
    readinessProbe:
      exec:
        command: ["pg_isready", "-h", "127.0.0.1", "-p", "55432", "-U", "postgres"]
      periodSeconds: 10
    volumeMounts:
      - name: msdash-db
        mountPath: /var/lib/postgresql/data
```

- 원본 서버는 `MSDASH_MODE=origin`, 고유한 `MSDASH_SERVER_ID`, 원본 서버의 `MSDASH_PUBLIC_URL`, 별도의 DB 경로를 사용합니다. 중계 서버용 `MSDASH_ORIGIN_URL`과 `MSDASH_PIPE_IP`는 제거합니다.
- 중계 서버의 `MSDASH_ORIGIN_URL`은 **중계 msdash 컨테이너에서 접근 가능한 원본 대시보드 주소**여야 합니다. `MSDASH_PUBLIC_URL`도 해당 주소를 사용하는 다른 서버와 브라우저에서 접근 가능해야 합니다.
- `MSDASH_DATABASE_URL`의 `127.0.0.1`은 msdash와 DB가 **같은 Pod의 네트워크 네임스페이스**를 공유한다는 가정입니다. DB를 별도 Pod로 운영한다면 Service 주소와 포트를 사용하세요. DB 비밀번호에 URL 예약 문자가 있으면 연결 문자열에 맞게 인코딩해야 합니다.
- `hostPath`는 해당 노드의 경로에 저장됩니다. Pod가 다른 노드로 옮겨지면 같은 데이터가 보장되지 않으므로 환경에 따라 PVC 등 적절한 영구 볼륨을 사용하세요. 여러 서버가 같은 DB 경로를 공유하지 않도록 합니다.
- 대시보드의 `containerPort`는 외부 접근을 자동으로 열지 않습니다. Service 또는 hostPort를 환경에 맞게 설정하세요. 같은 노드에서 동일 hostPort를 중복 사용할 수 없습니다.
- 수집 주기는 기본 10초이고 `MSDASH_COLLECT_INTERVAL_MS`로 변경할 수 있습니다. `MSDASH_NIC_CAPACITY_BPS`는 화면의 용량 기준값이며 실제 NIC 용량을 자동 측정한 값은 아닙니다.
- 대시보드 API에는 인증이 없으므로 접근 가능한 네트워크를 제한하세요. 실제 적용 전에 `kubectl diff -f <새-yaml>`로 변경 범위를 확인하세요. Pod 종류와 변경 내용에 따라 mediasoup 프로세스가 함께 재시작될 수 있습니다.
- 저장소의 `deploy/k8s/`는 참고용 overlay입니다. sibling `qos` 경로와 Deployment를 가정하므로, 현재 사용하는 독립 Pod나 다른 배포 구조에 그대로 적용하지 마세요.

### 5. 적용과 확인

```bash
kubectl diff -f <새-origin-yaml>
kubectl diff -f <새-edge-yaml>

kubectl apply -f <새-origin-yaml>
kubectl apply -f <새-edge-yaml>

kubectl get pods -n qos -o wide
kubectl describe pod <pod-이름> -n qos
kubectl logs <pod-이름> -n qos -c mediasoup-server
kubectl logs <pod-이름> -n qos -c msdash
kubectl logs <pod-이름> -n qos -c msdash-db
curl http://<대시보드-접근주소>:18080/api/health
```

`/api/health`에서 `source: "hook"`, `collector` 상태, `dbLastError`를 확인합니다. 초기 기동 중에는 수집이나 DB가 준비되는 데 시간이 걸릴 수 있습니다. `ImagePullBackOff`는 Pod의 Events에서 이미지 주소·태그·pull Secret·레지스트리 접근을 확인합니다. Hook 소켓 오류는 ConfigMap, 두 컨테이너의 공유 볼륨과 소켓 경로를 확인합니다.
