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
