import { Status } from '../../components/Status';

/** origin에서 본 edge 상태 (AGENT_TASK 7-6). 끊겨도 "열기 ↗"는 남기고 경고 문구를 붙인다. */
export function EdgeState({ state, reason }: { state: 'connected' | 'warning' | 'lost' | null; reason?: string | null }) {
	if (state === 'lost') {
		return (
			<span title={reason ?? undefined}>
				<Status level="crit">신호 끊김</Status>
			</span>
		);
	}

	if (state === 'warning') {
		return (
			<span title={reason ?? undefined}>
				<Status level="warn">연결됨 · 품질 경고</Status>
			</span>
		);
	}

	if (state === 'connected') {
		return <Status level="ok">연결됨</Status>;
	}

	return <span className="muted">—</span>;
}

/** edge 대시보드 새 탭 링크. 신호가 끊긴 edge는 열리지 않을 수 있다고 알린다. */
export function OpenEdge({ url, state }: { url: string | null; state?: string | null }) {
	if (!url) {
		return <span className="faint" title="edge가 대시보드 주소를 보내지 않았습니다">주소 없음</span>;
	}

	return (
		<span style={{ whiteSpace: 'nowrap' }}>
			<a href={url} target="_blank" rel="noreferrer">
				열기 ↗
			</a>
			{state === 'lost' && <span className="warn small"> ▲ 응답 없을 수 있음</span>}
		</span>
	);
}

export const INGEST: Record<string, { level: 'ok' | 'warn' | 'info'; text: string }> = {
	ok: { level: 'ok', text: '정상' },
	loss: { level: 'warn', text: '입력 loss' },
	idle: { level: 'info', text: '송출 없음' },
};
