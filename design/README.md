# 디자인 시안 (샘플 데이터)

- `screenshots/` : 각 화면의 전체 캡처 (1360px 너비). 먼저 이걸 보세요.
- `html/`        : 각 화면의 원본 마크업. 색, 간격, 글꼴, 문구, 샘플 숫자를 그대로 확인할 수 있습니다.
                   브라우저에서 바로 열립니다 (Google Fonts 접속 필요, 없으면 기본 글꼴로 보입니다).
                   `.dc.html`은 디자인 도구 형식이라 `<x-dc>`, `<helmet>` 같은 태그가 섞여 있습니다. 구현 코드로 그대로 쓰지 말고 참고용으로만 쓰세요.

## 화면 대응

| 파일 | 화면 |
|---|---|
| A3-EdgeLocal | edge · Overview |
| A3-Workers | edge · Workers |
| A3-Broadcasts | edge · Broadcasts (routers) |
| A3-Pipe | edge · Pipe 수신 |
| A3-Viewers | edge · Viewers |
| A3-ViewerDetail | edge · Viewer 상세 (재생 상태) |
| A3-Alerts | edge · Alerts |
| A3-States | 공통 · UI 상태 6종, 갱신 정책 |
| O1-Overview | origin · Overview |
| O2-Rooms | origin · Rooms & Broadcasters |
| O3-Broadcaster | origin · Broadcaster 상세 |
| O4-Edges | origin · Connected Edges |

## 시안과 지시서가 다른 부분 (지시서가 우선)

- 시안에 남아 있는 **"집계 노드 연결됨/정상"** 문구(A3-EdgeLocal 상단 띠, A3-Pipe의 "Origin 측 값과 비교")는 이전 구조(별도 집계 노드)의 잔재입니다. 현재 구조에는 집계 노드가 없습니다. 상단 띠는 "이 서버의 수집 상태"로 바꾸세요.
- A3-Pipe의 **"Origin 송신 vs 여기 수신" 비교**는 edge가 origin의 송신 값을 알아야 가능합니다. 지금 구조에서는 edge가 자기 데이터만 갖습니다. 이 비교 패널을 넣을지는 미정이므로, 구현하지 말고 보고 항목으로 남기세요.
- A3-Alerts의 **"확인함(acknowledge)" 버튼과 "채널: Slack/웹훅"** 문구는 읽기 전용 데모와 맞지 않습니다. 버튼은 만들지 않고, 채널 문구는 빼세요.
- 사이드바의 `Origin 대시보드 ↗`는 실제 origin 주소로 연결합니다.
