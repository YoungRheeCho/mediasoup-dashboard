-- =====================================================================
-- mediasoup 모니터링 · ORIGIN DB 스키마 초안 (TimescaleDB / Postgres 15+)
-- origin은 "방송자(broadcaster)와 방송, 연결된 edge"만 다룬다.
-- edge의 상세 품질 데이터는 저장하지 않는다 (각 edge 대시보드에서 본다).
-- 공통 규칙은 edge_schema.sql 상단과 같다.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------
-- 일반 테이블
-- ---------------------------------------------------------------------

CREATE TABLE room (
  room_id        text PRIMARY KEY,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- 알려진 edge 목록. 대시보드 링크("열기 ↗")의 원천.
CREATE TABLE edge (
  edge_id        text PRIMARY KEY,             -- 'edge-tokyo-1'
  dashboard_url  text NOT NULL,                -- 새 탭으로 열 주소
  region         text,
  ip             text,                         -- edge의 pipe 수신 IP. origin PipeTransport 원격 IP와 대조해 방송↔edge를 추정 (M7)
  first_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- broadcaster 접속 세션. 한 room에 여러 명 가능.
CREATE TABLE broadcaster_session (
  broadcaster_id   text PRIMARY KEY,           -- 세션 단위 id
  room_id          text NOT NULL REFERENCES room(room_id),
  display_name     text,                       -- 'host-kim'
  worker_idx       smallint,
  connected_at     timestamptz NOT NULL,
  disconnected_at  timestamptz,                -- NULL이면 접속 중
  state            text NOT NULL DEFAULT 'sending'
                   CHECK (state IN ('sending','idle','disconnected'))
);
CREATE INDEX broadcaster_active_idx ON broadcaster_session (room_id) WHERE disconnected_at IS NULL;

-- room ↔ edge 연결 현재 상태 (origin이 어느 edge로 pipe를 열고 있는가)
CREATE TABLE room_edge_link (
  room_id        text NOT NULL REFERENCES room(room_id),
  edge_id        text NOT NULL REFERENCES edge(edge_id),
  state          text NOT NULL CHECK (state IN ('connected','closed','failed')),
  since          timestamptz NOT NULL,
  PRIMARY KEY (room_id, edge_id)
);

CREATE TABLE alert_rule (
  rule_id        text PRIMARY KEY,
  title          text NOT NULL,
  metric         text NOT NULL,
  warn_above     double precision,
  crit_above     double precision,
  window_seconds integer NOT NULL,
  enabled        boolean NOT NULL DEFAULT true
);

CREATE TABLE alert_event (
  alert_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id       text NOT NULL REFERENCES alert_rule(rule_id),
  severity      text NOT NULL CHECK (severity IN ('warn','crit')),
  state         text NOT NULL CHECK (state IN ('firing','resolved')),
  subject_type  text NOT NULL,                 -- 'broadcaster' | 'room' | 'edge' | 'server'
  subject_id    text,
  value         double precision,
  threshold     double precision,
  started_at    timestamptz NOT NULL,
  resolved_at   timestamptz
);
CREATE INDEX alert_event_time_idx ON alert_event (started_at DESC);

-- ---------------------------------------------------------------------
-- 시계열
-- ---------------------------------------------------------------------

-- 수집기 자신의 상태 (edge_schema.sql의 collector_sample과 같음)
CREATE TABLE collector_sample (
  time                timestamptz NOT NULL,
  hook_ok             boolean     NOT NULL,
  collect_duration_ms integer,
  collect_skipped     boolean     NOT NULL DEFAULT false,
  event_loop_lag_ms   real,
  node_rss_bytes      bigint,
  host_cpu_pct        real
);
SELECT create_hypertable('collector_sample', 'time', chunk_time_interval => interval '1 day');

-- origin 서버 자원 (workers 합산 또는 worker별)
CREATE TABLE worker_sample (
  time            timestamptz NOT NULL,
  worker_idx      smallint    NOT NULL,
  cpu_pct         real,
  mem_rss_bytes   bigint,
  router_count    smallint,
  transport_count integer,
  producer_count  integer,
  consumer_count  integer
);
SELECT create_hypertable('worker_sample', 'time', chunk_time_interval => interval '1 day');

-- broadcaster 입력 품질 — 약 2초~10초. 상세 화면(2초)은 최근 구간만 raw로 읽는다.
CREATE TABLE broadcaster_sample (
  time              timestamptz NOT NULL,
  broadcaster_id    text        NOT NULL,
  room_id           text        NOT NULL,
  bitrate_bps       bigint,
  fps               real,                      -- mediasoup producer stats에 fps가 없어 현재 mock (M8)
  packets_expected  bigint,                    -- delta (producer 수신 stream: 받은 media 패킷 + 유실)
  packets_lost      bigint,                    -- delta, 복구 전 원본 loss
  packets_repaired  bigint,                    -- delta, RTX/NACK으로 복구된 패킷
  rtt_ms            real,                      -- 수신 측이라 값이 없을 수 있다 → NULL
  jitter_ms         real,
  nack_count        integer,                   -- delta
  pli_count         integer,                   -- delta
  layers_active     smallint                   -- simulcast 활성 레이어 수
);
SELECT create_hypertable('broadcaster_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON broadcaster_sample (broadcaster_id, time DESC);
CREATE INDEX ON broadcaster_sample (room_id, time DESC);

-- origin이 본 방송 단위: origin 쪽 viewer 수와 pipe로 내보내는 양
CREATE TABLE room_sample (
  time             timestamptz NOT NULL,
  room_id          text        NOT NULL,
  viewer_count     integer     NOT NULL,       -- origin에 직접 붙은 viewer
  out_pipe_bitrate_bps bigint                  -- 모든 edge로 나가는 합
);
SELECT create_hypertable('room_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON room_sample (room_id, time DESC);

-- origin → edge pipe 송신 (O2 "방송별 edge 수신 측 보고 loss"의 원천)
-- origin의 pipe consumer stats(outbound-rtp)에 edge가 RTCP RR로 알려 준 loss·RTT가 들어 있다.
-- edge_id는 PipeTransport 원격 IP를 edge 목록과 대조해 추정한다 (M7). 못 찾으면 NULL.
CREATE TABLE pipe_send_sample (
  time              timestamptz NOT NULL,
  room_id           text        NOT NULL,
  edge_id           text,
  remote_ip         text        NOT NULL,      -- 추정 근거
  producer_id       text        NOT NULL,
  kind              text        NOT NULL,      -- 'video' | 'audio'
  packets_expected  bigint,                    -- delta, origin이 보낸 패킷
  packets_lost      bigint,                    -- delta, edge의 RR이 보고한 유실
  bitrate_bps       bigint,
  rtt_ms            real,
  nack_count        integer,                   -- delta, edge가 보낸 NACK
  pli_count         integer                    -- delta
);
SELECT create_hypertable('pipe_send_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON pipe_send_sample (room_id, time DESC);
CREATE INDEX ON pipe_send_sample (edge_id, time DESC);

-- edge가 보낸 heartbeat (dead-man's switch). origin 화면의 "마지막 신호"의 원천.
-- edge가 직접 push 하거나 origin이 주기적으로 확인한다.
CREATE TABLE edge_heartbeat (
  time            timestamptz NOT NULL,
  edge_id         text        NOT NULL,
  ok              boolean     NOT NULL,        -- false: 응답은 왔으나 자체 점검 실패
  rtt_ms          real,
  viewer_count    integer,                     -- 요약 숫자만. 상세는 edge 대시보드에서 본다.
  -- edge가 보고한 pipe 수신 loss (요약). 공통 규칙대로 비율 대신 delta 두 개로 저장한다.
  recv_packets_lost     bigint,                -- 직전 heartbeat 이후 delta
  recv_packets_expected bigint                 -- 직전 heartbeat 이후 delta
);
SELECT create_hypertable('edge_heartbeat', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON edge_heartbeat (edge_id, time DESC);

-- 보관: origin은 데이터가 적어 모두 7~14일. 압축은 선택.
ALTER TABLE broadcaster_sample SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'broadcaster_id', timescaledb.compress_orderby = 'time DESC');
ALTER TABLE pipe_send_sample SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'room_id', timescaledb.compress_orderby = 'time DESC');
SELECT add_compression_policy('broadcaster_sample', interval '1 day');
SELECT add_compression_policy('pipe_send_sample',   interval '1 day');
SELECT add_retention_policy('broadcaster_sample', interval '7 days');
SELECT add_retention_policy('pipe_send_sample',   interval '7 days');
SELECT add_retention_policy('collector_sample',   interval '7 days');
SELECT add_retention_policy('worker_sample',      interval '7 days');
SELECT add_retention_policy('room_sample',        interval '14 days');
SELECT add_retention_policy('edge_heartbeat',     interval '14 days');

-- ---------------------------------------------------------------------
-- 초기화 완료 표시. 사이드카는 이 행이 있어야 스키마가 끝까지 적용된 것으로 본다.
-- (적용 도중 프로세스가 죽어 반쯤 만들어진 DB를 알아보고 다시 만들기 위함)
-- ---------------------------------------------------------------------
CREATE TABLE msdash_schema (version integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO msdash_schema (version) VALUES (1);
