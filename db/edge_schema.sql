-- =====================================================================
-- mediasoup 모니터링 · EDGE 로컬 DB 스키마 초안 (TimescaleDB / Postgres 15+)
-- 이 DB는 "이 edge 서버 하나"의 데이터만 담는다. 그래서 server_id 컬럼이 없다.
--
-- 공통 규칙
--  * time        : 수집 서버가 찍은 시각 (timestamptz). client 시계는 쓰지 않는다.
--  * *_delta     : 직전 수집 이후 증가분. 누적값을 그대로 저장하지 않는다.
--                  (서버 재시작으로 누적값이 줄어들면 그 구간은 저장하지 않는다)
--  * NULL        : "수집 못 함 / 보고 없음". 0과 구분한다.
--  * 비율은 저장하지 않고 delta 두 개(lost, expected)로 저장한다.
--    → 어떤 길이의 구간으로 합쳐도 sum(lost)/sum(expected)로 정확히 계산된다.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------
-- 1. 일반 테이블 (행이 적고 수정이 있는 것)
-- ---------------------------------------------------------------------

-- 방송(room) 목록. 같은 roomId에 여러 broadcaster가 있어도 방송은 1행.
CREATE TABLE room (
  room_id        text PRIMARY KEY,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- viewer 접속 세션. 접속 때 INSERT, 종료 때 disconnected_at UPDATE.
CREATE TABLE viewer_session (
  viewer_id        text PRIMARY KEY,           -- 세션 단위 id = viewer의 consumer용 WebRtcTransport id
                                               -- (재접속하면 새 id). docs/collection-design.md 1절
  room_id          text NOT NULL REFERENCES room(room_id),
  worker_idx       smallint,                   -- 이 viewer를 담당하는 worker (consumer router shard)
  connected_at     timestamptz NOT NULL,
  disconnected_at  timestamptz,                -- NULL이면 접속 중
  disconnect_reason text,                      -- 'client_closed' | 'transport_failed' | ... (M5: 현재 mock)
  -- 아래는 signaling peer 정보. 서버가 transport appData에 peerId를 넣으면 room.serialize()의 peer에서
  -- 실제 값을 채우고(identity_source='peer'), 아니면 mock(M1, identity_source='mock')이다.
  identity_source  text,                       -- 'peer' | 'mock' | NULL
  peer_id          text,
  display_name     text,
  device_flag      text,                       -- 'chrome' | 'safari' | ... (room.serialize()의 device.flag)
  browser_name     text,                       -- device.name (예: 'Chrome'). 실제 신원일 때만
  browser_version  text,                       -- device.version. 실제 신원일 때만
  remote_ip        text,                       -- viewer 실제 IP (getStats iceSelectedTuple.remoteIp). 실제 신원일 때만
  -- 아래는 client가 알려 주는 정적 정보. 없을 수 있다.
  network_type     text,                       -- 'wifi' | 'lte' | 'wired' | NULL (M3: 현재 mock)
  device_class     text,                       -- 'mobile' | 'desktop' | NULL
  user_agent       text                        -- (M4: 현재 mock)
);
CREATE INDEX viewer_session_active_idx ON viewer_session (room_id) WHERE disconnected_at IS NULL;
CREATE INDEX viewer_session_time_idx   ON viewer_session (connected_at DESC);

-- 알림 규칙 (읽기 전용 데모라 UI에서 수정하진 않고, 시드 데이터로 넣는다)
CREATE TABLE alert_rule (
  rule_id        text PRIMARY KEY,             -- 'pipe_loss', 'viewer_loss_ratio' ...
  title          text NOT NULL,
  metric         text NOT NULL,
  warn_above     double precision,
  crit_above     double precision,
  window_seconds integer NOT NULL,             -- 이 시간 동안 유지되면 발동
  enabled        boolean NOT NULL DEFAULT true
);

-- 알림 이력. 발동 시 INSERT(state='firing'), 해소 시 resolved_at 채우고 state='resolved'.
CREATE TABLE alert_event (
  alert_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id       text NOT NULL REFERENCES alert_rule(rule_id),
  severity      text NOT NULL CHECK (severity IN ('warn','crit')),
  state         text NOT NULL CHECK (state IN ('firing','resolved')),
  subject_type  text NOT NULL,                 -- 'worker' | 'room' | 'pipe' | 'viewer' | 'server'
  subject_id    text,
  value         double precision,              -- 발동 시점 값
  threshold     double precision,
  started_at    timestamptz NOT NULL,
  resolved_at   timestamptz
);
CREATE INDEX alert_event_time_idx   ON alert_event (started_at DESC);
CREATE INDEX alert_event_firing_idx ON alert_event (rule_id) WHERE state = 'firing';

-- ---------------------------------------------------------------------
-- 2. 시계열 테이블 (hypertable)
-- ---------------------------------------------------------------------

-- 2-0. 수집기 자신의 상태 — 상단 띠 "이 서버의 수집 상태", getServerSeries
--      훅이 mediasoup 프로세스 안에서 돌기 때문에 부하를 직접 본다 (collection-design.md H4).
CREATE TABLE collector_sample (
  time                timestamptz NOT NULL,
  hook_ok             boolean     NOT NULL,    -- 훅 소켓 응답 성공 여부
  collect_duration_ms integer,                 -- 이번 주기 수집에 걸린 시간
  collect_skipped     boolean     NOT NULL DEFAULT false,  -- 이전 수집이 길어져 이번 주기를 건너뜀
  event_loop_lag_ms   real,                    -- mediasoup Node 프로세스 이벤트 루프 지연 (p99)
  node_rss_bytes      bigint,                  -- mediasoup Node 프로세스 RSS
  host_cpu_pct        real                     -- 노드 전체 CPU
);
SELECT create_hypertable('collector_sample', 'time', chunk_time_interval => interval '1 day');

-- 2-1. worker 단위 — 수집 주기 약 10초
CREATE TABLE worker_sample (
  time              timestamptz NOT NULL,
  worker_idx        smallint    NOT NULL,
  cpu_pct           real,                      -- 구간 평균 CPU 사용률 (0~100)
  mem_rss_bytes     bigint,                    -- 현재 RSS (/proc/<pid>/status). ru_maxrss(최대치)가 아님
  router_count      smallint,
  transport_count   integer,
  producer_count    integer,
  consumer_count    integer
);
SELECT create_hypertable('worker_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON worker_sample (worker_idx, time DESC);

-- 2-2. 방송(room/router) 단위 — 이 edge에서 이 방송이 어떻게 나가는가
CREATE TABLE room_sample (
  time              timestamptz NOT NULL,
  room_id           text        NOT NULL,
  worker_idx        smallint    NOT NULL,      -- 방송이 worker 두 개에 걸치면 worker마다 1행
  viewer_count      integer     NOT NULL,
  producer_count    smallint,                  -- pipe로 들어온 producer 수
  out_bitrate_bps   bigint,                    -- 이 방송으로 나가는 총 bitrate
  in_bitrate_bps    bigint                     -- pipe로 들어오는 bitrate
);
SELECT create_hypertable('room_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON room_sample (room_id, time DESC);

-- 2-3. pipe 수신 — origin→edge 방향 하나뿐. producer 단위.
CREATE TABLE pipe_sample (
  time              timestamptz NOT NULL,
  room_id           text        NOT NULL,
  producer_id       text        NOT NULL,      -- pipe로 받는 producer
  kind              text        NOT NULL,      -- 'video' | 'audio'
  -- mediasoup RtpStreamRecv는 원래 전송분만 media 카운터에 세고 RTX 복구분은 packetsRepaired로 따로 센다.
  -- 그래서 수신 측에서는 packets_lost = 복구 전 원본 loss, (packets_lost - packets_repaired) = 복구 후 근사.
  packets_expected  bigint,                    -- 구간 동안 와야 했던 패킷 (delta, 받은 media 패킷 + 유실)
  packets_lost      bigint,                    -- 구간 동안 유실된 패킷 (delta, 원본 기준)
  packets_repaired  bigint,                    -- 구간 동안 RTX/NACK으로 복구된 패킷 (delta)
  bitrate_bps       bigint,
  rtt_ms            real,
  jitter_ms         real,
  nack_count        integer,                   -- delta
  pli_count         integer                    -- delta
);
SELECT create_hypertable('pipe_sample', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON pipe_sample (room_id, time DESC);

-- 2-4. viewer 단위 — 가장 큰 테이블. 약 10초 주기, 초당 ~120행.
--      "서버가 본 값"과 "브라우저가 보고한 값"을 컬럼 그룹으로 분리한다.
CREATE TABLE viewer_sample (
  time              timestamptz NOT NULL,
  viewer_id         text        NOT NULL,
  room_id           text        NOT NULL,      -- 조인 없이 방송별 집계하려고 중복 저장

  worker_idx        smallint,                  -- 담당 worker (shard별 필터용)

  -- (A) 서버가 직접 잰 값 : 집계·알림의 기준
  -- loss 정의 (docs/collection-design.md M9):
  --   서버가 아는 viewer 구간 loss는 viewer가 보낸 RTCP RR 뿐이다. 브라우저는 RTX로 복구된 패킷을
  --   받은 것으로 세므로 RR loss는 "복구 후 loss"에 가깝다. 복구 전 원본 loss는 서버에서 얻을 수 없다.
  --   → packets_lost = RR 기반 loss, packets_lost_unrecovered 컬럼은 제거,
  --     복구 전 손실의 근사치는 nack_count / packets_retransmitted로 상세 화면에서만 보여 준다.
  packets_expected  bigint,                    -- delta, SFU가 이 viewer에게 보낸 패킷 수 (consumer outbound-rtp packetCount)
  packets_lost      bigint,                    -- delta, RR이 보고한 유실 (consumer outbound-rtp packetsLost)
  nack_count        integer,                   -- delta, viewer가 보낸 NACK
  packets_retransmitted bigint,                -- delta, SFU가 재전송한 패킷
  rtt_ms            real,
  bitrate_bps       bigint,
  spatial_layer     smallint,
  temporal_layer    smallint,
  transport_state   text,                      -- 'connected' | 'disconnected' | ...

  -- (B) viewer 브라우저가 보고한 값 : 상세 화면 전용. 보고 없으면 전부 NULL.
  --     클라이언트가 reportClientStats로 보내면 실제 값(client_reported=true), 아니면 mock (M2, client_reported=false).
  client_reported   boolean     NOT NULL DEFAULT false,
  client_freeze_count  integer,                -- delta
  client_freeze_ms     integer,                -- delta
  client_fps           real,
  client_jitter_buffer_ms real,
  client_frames_dropped integer                -- delta
);
SELECT create_hypertable('viewer_sample', 'time', chunk_time_interval => interval '6 hours');
CREATE INDEX ON viewer_sample (viewer_id, time DESC);
CREATE INDEX ON viewer_sample (room_id, time DESC);

-- ---------------------------------------------------------------------
-- 3. 집계 (continuous aggregate) — 목록·개요 화면은 이것만 읽는다
-- ---------------------------------------------------------------------

-- 방송별 viewer 품질, 1분 단위
CREATE MATERIALIZED VIEW viewer_room_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time)                       AS bucket,
  room_id,
  count(DISTINCT viewer_id)                           AS viewer_count,
  sum(packets_lost)                                   AS packets_lost,
  sum(packets_expected)                               AS packets_expected,
  avg(rtt_ms)                                         AS rtt_avg_ms,
  max(rtt_ms)                                         AS rtt_max_ms,
  -- 구간 내 viewer별 loss가 5% 이상인 샘플 수 (분모는 sample_count)
  count(*) FILTER (WHERE packets_expected > 0
                   AND packets_lost::float / packets_expected >= 0.05) AS bad_samples,
  count(*)                                            AS sample_count
FROM viewer_sample
GROUP BY bucket, room_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('viewer_room_1m',
  start_offset => interval '2 hours', end_offset => interval '1 minute',
  schedule_interval => interval '1 minute');

-- pipe 품질, 1분 단위
CREATE MATERIALIZED VIEW pipe_room_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  room_id,
  sum(packets_lost)     AS packets_lost,
  sum(packets_repaired) AS packets_repaired,
  sum(packets_expected) AS packets_expected,
  avg(rtt_ms)           AS rtt_avg_ms,
  max(rtt_ms)           AS rtt_max_ms,
  avg(jitter_ms)        AS jitter_avg_ms,
  sum(bitrate_bps)      AS bitrate_sum_bps_samples,   -- 표시할 땐 / 샘플 수로 환산
  sum(nack_count)       AS nack_count,
  sum(pli_count)        AS pli_count
FROM pipe_sample
GROUP BY bucket, room_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('pipe_room_1m',
  start_offset => interval '2 hours', end_offset => interval '1 minute',
  schedule_interval => interval '1 minute');

-- 화면에서 "loss 비율"이 필요하면 이렇게 계산한다 (저장하지 않음)
--   sum(packets_lost)::float / NULLIF(sum(packets_expected), 0)
-- p50/p95는 최근 5분처럼 짧은 구간만 raw에서 직접 계산한다 (percentile_cont).

-- ---------------------------------------------------------------------
-- 4. 보관 기간 + 압축
-- ---------------------------------------------------------------------
-- 원본은 짧게, 집계는 길게. 숫자는 시작값이므로 실제 용량을 보고 조정한다.
--   viewer_sample raw      : 48시간   (개별 viewer 상세는 최근 이틀까지)
--   worker/room/pipe raw   : 7일
--   collector raw          : 7일
--   1분 집계               : 14일
--   alert_event            : 영구 (행이 적음)
-- 아래 보관 기간은 기본값이다. 수집기가 시작할 때 설정값으로 정책을 다시 건다
-- (remove_retention_policy → add_retention_policy). AGENT_TASK 3-3 "조정 가능하게".

ALTER TABLE viewer_sample SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'room_id', timescaledb.compress_orderby = 'viewer_id, time DESC');
ALTER TABLE pipe_sample   SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'room_id', timescaledb.compress_orderby = 'time DESC');
ALTER TABLE room_sample   SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'room_id', timescaledb.compress_orderby = 'time DESC');
ALTER TABLE worker_sample SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'worker_idx', timescaledb.compress_orderby = 'time DESC');

SELECT add_compression_policy('viewer_sample', interval '12 hours');
SELECT add_compression_policy('pipe_sample',   interval '1 day');
SELECT add_compression_policy('room_sample',   interval '1 day');
SELECT add_compression_policy('worker_sample', interval '1 day');

SELECT add_retention_policy('viewer_sample', interval '48 hours');
SELECT add_retention_policy('pipe_sample',   interval '7 days');
SELECT add_retention_policy('room_sample',   interval '7 days');
SELECT add_retention_policy('worker_sample', interval '7 days');
SELECT add_retention_policy('collector_sample', interval '7 days');
SELECT add_retention_policy('viewer_room_1m', interval '14 days');
SELECT add_retention_policy('pipe_room_1m',   interval '14 days');

-- ---------------------------------------------------------------------
-- 초기화 완료 표시. 사이드카는 이 행이 있어야 스키마가 끝까지 적용된 것으로 본다.
-- (적용 도중 프로세스가 죽어 반쯤 만들어진 DB를 알아보고 다시 만들기 위함)
-- ---------------------------------------------------------------------
CREATE TABLE msdash_schema (version integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO msdash_schema (version) VALUES (1);
