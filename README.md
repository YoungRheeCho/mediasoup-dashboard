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

**통합 3D 화면 (origin):** origin 대시보드 첫 화면(`/`)이 모든 edge·시청자를 합친 3D 화면입니다. edge들이 1초마다 보내는 실시간 값을 origin이 합쳐 보여 줍니다(`/api/central/snapshot`, `/api/central/stream`). 기존 화면은 `/overview`에 그대로 있습니다. 수집은 1초, DB 기록은 10초 주기입니다([docs/deploy.md](docs/deploy.md) 설정 표). 예시 값(MOCK)으로 채운 항목은 [docs/mock-data.md](docs/mock-data.md).


### 1. 이미지 빌드 및 업로드

프로젝트 루트에서 실행

```bash
git clone https://github.com/YoungRheeCho/mediasoup-dashboard.git
cd mediasoup-dashboard

sudo docker build -t <image tag> .
```


### 2. Hook ConfigMap 준비

프로젝트 루트에서 저장소의 Hook을 사용한다면:

```bash
kubectl create configmap msdash-hook -n qos \
  --from-file=msdash-hook.cjs=hook/msdash-hook.cjs \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl get configmap msdash-hook -n qos
```

Hook이 `~/msdash-hook.cjs`에 있다면 경로는 `--from-file=msdash-hook.cjs=$HOME/msdash-hook.cjs`로 지정

### 3. DB 비밀번호 준비: 테스트용 평문 또는 Secret

DB Secret은 필수가 아닙니다. 임시로 `msdash`의 `DB_PASSWORD`와 `msdash-db`의 `POSTGRES_PASSWORD`에 **같은 값을 평문으로** 넣어도 괜찮음. (아래 YAML 예시에서도 이 방식을 사용)

```yaml
# msdash 컨테이너의 env
- name: DB_PASSWORD
  value: "여기에 비밀번호 기입"
- name: MSDASH_DATABASE_URL # DB_PASSWORD 다음에 선언
  value: "postgres://postgres:$(DB_PASSWORD)@127.0.0.1:55432/msdash"

# msdash-db 컨테이너의 env
- name: POSTGRES_PASSWORD
  value: "여기에 비밀번호 기입"
```

**선택 사항: Secret 사용.** `msdash-db` Secret의 `password` 키를 준비한 뒤 두 비밀번호 항목 모두 `value` 대신 아래의 `valueFrom`을 사용합니다. `MSDASH_DATABASE_URL`은 그대로 `$(DB_PASSWORD)`를 참조합니다.

```yaml
valueFrom:
  secretKeyRef:
    name: msdash-db
    key: password
```

Secret 존재 여부는 `kubectl get secret msdash-db -n qos`로 확인합니다. Secret의 값과 DB에 실제 설정된 비밀번호가 같아야 하며, 기존 DB가 있을 때 Secret만 바꾸면 DB 비밀번호는 변경되지 않습니다.

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
        value: edge-0 # 서버별로 유일한 이름으로 변경 (한 노드에 여러 개면 Pod 이름 권장: fieldRef metadata.name)
      - name: NODE_NAME # 이 Pod가 도는 노드 이름. 통합 3D 화면이 노드별로 묶는 데 쓴다
        valueFrom:
          fieldRef:
            fieldPath: spec.nodeName
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
        value: "CHANGE_ME_TEST_PASSWORD" # 임시 테스트 예시
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
        value: "CHANGE_ME_TEST_PASSWORD" # DB_PASSWORD와 동일한 값
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
