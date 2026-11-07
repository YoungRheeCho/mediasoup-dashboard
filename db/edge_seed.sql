-- edge 알림 규칙 시드 (AGENT_TASK 6.3). UI에서 수정하지 않는다.
-- loss 값은 비율(0~1), CPU는 %, 지연은 ms. 임계값은 시작값이므로 운영하며 조정한다.
-- score 기반 규칙은 만들지 않는다. mock 값은 평가 대상에서 제외한다.
INSERT INTO alert_rule (rule_id, title, metric, warn_above, crit_above, window_seconds) VALUES
  ('pipe_loss',         'Pipe 수신 loss',              'pipe.loss_ratio',          0.02, 0.05, 30),
  ('worker_cpu',        'Worker CPU',                  'worker.cpu_pct',           70,   90,   60),
  ('viewer_loss_p50',   'Viewer loss 중앙값(p50)',      'viewer.loss_ratio.p50',    0.02, 0.05, 60),
  ('viewer_bad_ratio',  'loss 5% 이상 viewer 비율',     'viewer.bad_ratio',         0.10, 0.25, 60),
  ('collector_lag',     '수집기 이벤트 루프 지연',       'collector.event_loop_lag_ms', 100, 500, 30)
ON CONFLICT (rule_id) DO NOTHING;

-- 스키마 변경분. 이 파일은 시작할 때마다 실행되므로(이미 만든 DB 포함) 여기서 컬럼을 보탠다. 여러 번 실행해도 안전하다.
-- viewer 실제 신원 (M1: 서버가 transport appData에 peerId를 넣은 경우)
ALTER TABLE viewer_session
  ADD COLUMN IF NOT EXISTS identity_source text,
  ADD COLUMN IF NOT EXISTS browser_name    text,
  ADD COLUMN IF NOT EXISTS browser_version text,
  ADD COLUMN IF NOT EXISTS remote_ip       text;
