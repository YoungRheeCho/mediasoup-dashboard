-- origin 알림 규칙 시드 (AGENT_TASK 6.3). UI에서 수정하지 않는다.
-- loss 값은 비율(0~1), CPU는 %, 시간은 초. 임계값은 시작값이므로 운영하며 조정한다.
INSERT INTO alert_rule (rule_id, title, metric, warn_above, crit_above, window_seconds) VALUES
  ('broadcaster_loss',  'Broadcaster 입력 loss',        'broadcaster.loss_ratio',   0.02, 0.05, 30),
  ('worker_cpu',        'Worker CPU',                  'worker.cpu_pct',           70,   90,   60),
  ('pipe_send_loss',    'edge 수신 측 보고 loss',        'pipe_send.loss_ratio',     0.02, 0.05, 30),
  ('edge_signal_age',   'edge 신호 끊김',               'edge.heartbeat_age_s',     30,   120,  0),
  ('collector_lag',     '수집기 이벤트 루프 지연',       'collector.event_loop_lag_ms', 100, 500, 30)
ON CONFLICT (rule_id) DO NOTHING;
