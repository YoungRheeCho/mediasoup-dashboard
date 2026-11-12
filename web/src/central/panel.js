/* 통합 3D 화면(central.html)의 아래 상세 패널: 차트 + 서버/시청자/origin 구성.
 * 시안 design/variants/121(배치 012 아래 시트, 색 002 그래파이트)을 실제 데이터로 옮긴 것.
 * 이력은 1초 간격 배열(마지막 칸 = 지금, 값이 없는 초는 null). 그래프는 null에서 선을 끊는다. */

const W = 320;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const C = () => ({ acc: css('--acc') || '#7aa2ff', acc2: css('--acc2') || '#c792ea', ok: css('--ok') || '#4ade80', warn: css('--amber') || '#ffb547', bad: css('--red') || '#ff4d6d', grid: '#ffffff14', axis: '#ffffff26', muted: css('--muted') || '#a0aec0', ink: css('--ink') || '#fff' });
export const lastNum = a => { for (let i = (a?.length ?? 0) - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const maxOf = a => a.reduce((m, v) => (v != null && v > m ? v : m), 0);
export const f1 = v => (v == null || Number.isNaN(v) ? '—' : Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v)));
export const fBps = b => (b == null ? '—' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbps' : Math.round(b / 1e3) + ' kbps');
export const ago = s => (s <= 0 ? '지금' : s < 60 ? s + '초 전' : Math.floor(s / 60) + '분' + (s % 60 ? ' ' + (s % 60) + '초' : '') + ' 전');
let uid = 0;

/* ---- 마우스를 올리면 그 시점 값 (그래프 데이터는 data-tip 번호로 메모리에 둔다) ---- */
const TIPS = new Map();
let tipSeq = 0;
export function resetTips() { TIPS.clear(); }
function regTip(t) { const id = ++tipSeq; TIPS.set(id, t); return id; }

/* null에서 끊기는 선 */
function pathOf(a, x, y, step) {
	let d = '', pen = false;
	for (let i = 0; i < a.length; i++) {
		const v = a[i];
		if (v == null) { pen = false; continue; }
		if (!pen) { d += `M${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; } else d += step ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
	}
	return d;
}
/* 영역 채우기: 끊긴 구간마다 따로 닫는다 */
function fillOf(a, x, y, h, step) {
	let d = '', s = -1;
	const close = e => { const seg = a.slice(s, e); d += pathOf([...Array(s).fill(null), ...seg], x, y, step) + `L${x(e - 1).toFixed(1)} ${h}L${x(s).toFixed(1)} ${h}Z`; };
	for (let i = 0; i <= a.length; i++) {
		if (i < a.length && a[i] != null) { if (s < 0) s = i; } else if (s >= 0) { close(i); s = -1; }
	}
	return d;
}
const gridLines = (max, y, unit, noLabel) => `<path d="M0 ${y(max / 2)}H${W}M0 ${y(max)}H${W}" stroke="${C().grid}" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><path d="M0 ${y(0)}H${W}" stroke="${C().axis}" vector-effect="non-scaling-stroke"/>${noLabel ? '' : `<!--YL:${max}${unit || ''}-->`}`;
/* 가로로 늘어나는 SVG 안에는 글자를 두지 않는다: 최대값·임계선 글자는 HTML로 겹친다 */
function svg(h, body, tip) {
	const tags = [];
	body = body.replace(/<!--YL:(.*?)-->/g, (_, t) => (tags.push(`<span class="k-yl">${t}</span>`), '')).replace(/<!--TH:(.*?)\|(.*?)\|(.*?)-->/g, (_, y, t, c) => (tags.push(`<span class="k-thl" style="top:${Math.round(+y - 11)}px;color:${c}">${t}</span>`), ''));
	const el = `<svg class="k-chart" viewBox="0 -2 ${W} ${h + 4}" preserveAspectRatio="none" style="height:${h + 4}px">${body}</svg>`;
	return `<div class="k-cw"${tip ? ` data-tip="${regTip(tip)}"` : ''}>${el}${tags.join('')}${tip ? '<i class="k-tipl"></i><div class="k-tip"></div>' : ''}</div>`;
}
const thLine = (o, y) => { if (o.th == null) return ''; const tc = o.thC || C().warn; return `<path d="M0 ${y(o.th)}H${W}" stroke="${tc}" stroke-width="${o.thW || 1}" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/><!--TH:${y(o.th)}|${o.thLabel || o.th}|${tc}-->`; };

/* 영역 그래프 (+ over: 겹쳐 그리는 두 번째 선, 점선) */
export function area(a, o = {}) {
	const h = o.h || 72, max = o.max || Math.max(1, Math.ceil(Math.max(maxOf(a), maxOf(o.over || [])) * 1.15)), c = o.c || C().acc, n = a.length;
	const x = i => (n <= 1 ? 0 : (i / (n - 1)) * W), y = v => h - 2 - (Math.min(Math.max(v, 0), max) / max) * (h - 8);
	const id = 'kg' + ++uid;
	let body = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".38"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>`;
	body += gridLines(max, y, o.unit, o.th != null && o.th >= max);
	body += `<path d="${fillOf(a, x, y, h, o.step)}" fill="url(#${id})"/><path d="${pathOf(a, x, y, o.step)}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
	if (o.over) body += `<path d="${pathOf(o.over, x, y, o.step)}" fill="none" stroke="${o.overC || C().bad}" stroke-width="1.3" stroke-dasharray="3 2" opacity=".9" vector-effect="non-scaling-stroke"/>`;
	body += thLine(o, y);
	const li = lastIdx(a);
	if (li >= 0) body += `<circle cx="${x(li)}" cy="${y(a[li])}" r="3" fill="${c}" stroke="#fff" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
	const tip = o.tip ? { u: o.tipU ?? o.unit ?? '', s: [{ n: o.tip[0], c, a }, ...(o.over ? [{ n: o.tip[1] || '', c: o.overC || C().bad, a: o.over }] : [])] } : null;
	return svg(h, body, tip);
}
const lastIdx = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return i; return -1; };

/* 여러 선 (list: [{a, c, n, w, step}]) */
export function lines(list, o = {}) {
	const h = o.h || 72, max = o.max || Math.max(1, Math.ceil(Math.max(...list.map(l => maxOf(l.a))) * 1.15)), n = list[0]?.a.length || 0;
	const x = i => (n <= 1 ? 0 : (i / (n - 1)) * W), y = v => h - 2 - (Math.min(Math.max(v, 0), max) / max) * (h - 8);
	let body = gridLines(max, y, o.unit, o.th != null && o.th >= max);
	body += list.map(l => `<path d="${pathOf(l.a, x, y, l.step ?? o.step)}" fill="none" stroke="${l.c}" stroke-width="${l.w || 1.8}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`).join('');
	body += thLine(o, y);
	return svg(h, body, o.tip ? { u: o.tipU ?? o.unit ?? '', s: list.map(l => ({ n: l.n || '', c: l.c, a: l.a })) } : null);
}

/* 상태 띠 (레이어). states: 0/1/2/null, marks: freeze가 있던 칸 */
export function timeline(states, colors, o = {}) {
	const h = o.h || 18, n = states.length, bw = W / Math.max(1, n);
	let out = '', s0 = 0;
	for (let i = 1; i <= n; i++) {
		if (i === n || states[i] !== states[s0]) {
			if (states[s0] != null) out += `<rect x="${(s0 * bw).toFixed(2)}" y="0" width="${Math.max(0.5, (i - s0) * bw - 0.5).toFixed(2)}" height="${h}" rx="2" fill="${colors[states[s0]] ?? colors[0]}"/>`;
			s0 = i;
		}
	}
	if (o.marks) out += o.marks.map(k => `<path d="M${(k * bw + bw / 2).toFixed(2)} -1V${h + 1}" stroke="${C().bad}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`).join('');
	const tip = o.tip ? { b: 1, u: '', s: [{ n: o.tip, c: C().muted, a: states.map((st, k) => (st == null ? null : (o.names ? o.names[st] : 'L' + st) + ((o.marks || []).includes(k) ? ' · 멈춤' : ''))) }] } : null;
	return svg(h, out, tip);
}

/* 반원 게이지 */
export function gauge(v, max, o = {}) {
	const s = o.size || 92, r = s / 2 - 8, cx = s / 2, cy = s / 2 + 4, p = v == null ? 0 : Math.min(1, Math.max(0, v / max)), c = o.c || (p >= 0.9 ? C().bad : p >= 0.8 ? C().warn : C().acc);
	const arc = t => { const a = Math.PI * (1 - t); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
	const [x0, y0] = arc(0), [x1, y1] = arc(p), [x2, y2] = arc(1);
	return `<svg width="${s}" height="${s * 0.7}" viewBox="0 0 ${s} ${s * 0.7}"><path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="${C().grid}" stroke-width="9" stroke-linecap="round"/>${v == null ? '' : `<path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" style="filter:drop-shadow(0 0 5px ${c})"/>`}<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="16" font-weight="800" fill="${C().ink}">${o.text ?? f1(v)}<tspan font-size="9" fill="${C().muted}">${v == null ? '' : o.unit || ''}</tspan></text></svg>`;
}

/* ---- 공통 조각 ---- */
export const axis = () => `<div class="k-axis"><span>30분 전</span><span>15분 전</span><span>지금</span></div>`;
export const sec = (title, right, body, span = 2) => `<section class="k-sec" style="--span:${span}"><h4><span>${title}</span>${right ? `<em>${right}</em>` : ''}</h4>${body}</section>`;
export const legend = items => `<div class="k-legend">${items.map(([c, t, box]) => `<span><i class="${box ? 'box' : ''}" style="--c:${c}"></i>${t}</span>`).join('')}</div>`;
const gauges = list => `<div class="k-gauges" style="--gc:${list.length}">${list.map(([g, cap]) => `<figure>${g}<figcaption>${cap}</figcaption></figure>`).join('')}</div>`;
const live = '<span class="k-live">LIVE</span>';
const nulls = n => new Array(n).fill(null);

/* 중계 서버 패널. r = snapshot.edges[i], h = 그 서버의 1초 이력 {cpu, peak, viewers, thrMs, egressBps} */
export function edgeSections({ r, h, cpuLabel, viewerCount }) {
	const n = h?.cpu.length || 1800, z = nulls(n);
	const cpu = h?.cpu ?? z, peak = h?.peak ?? z, vw = h?.viewers ?? z, thr = h?.thrMs ?? z, eg = (h?.egressBps ?? z).map(v => (v == null ? null : v / 1e6));
	const pk = r.cpuPeakPct;
	return [
		sec('CPU', live, gauges([[gauge(r.cpuPct, 100, { unit: '%', size: 104 }), cpuLabel === 'Container CPU' ? 'CPU 이용률' : cpuLabel], [gauge(pk, 100, { unit: '%', size: 104 }), 'CPU 최대']]), 2),
		sec('CPU 30분', `${r.cpuPct == null ? '—' : f1(r.cpuPct) + '%'} · 최대 ${pk == null ? '—' : f1(pk) + '%'}`, area(cpu, { max: 100, unit: '%', over: peak, h: 88, th: 100, thLabel: '100%', thW: 0.7, tip: ['이용률', '최대'] }) + legend([[C().acc, '이용률'], [C().bad, '최대']]) + axis(), 4),
		sec('시청자 수 30분', viewerCount + '명', area(vw, { step: true, c: C().acc2, unit: '명', h: 64, tip: ['시청자'] }) + axis(), 2),
		sec('Throttle (ms/초)', r.throttledMs == null ? '—' : r.throttledMs > 0 ? `<b style="color:${C().bad}">${f1(r.throttledMs)}ms</b>` : '없음', area(thr, { c: C().bad, unit: 'ms', h: 64, step: true, tip: ['Throttle'] }) + axis(), 2),
		sec('송신 비트레이트', fBps(lastNum(h?.egressBps ?? [])), area(eg, { c: C().ok, unit: 'M', h: 64, tip: ['송신'], tipU: ' Mbps' }) + axis(), 2),
	];
}

/* 시청자 패널. v = 화면의 시청자, h = 그 시청자의 1초 이력 {loss, rtt, fps, layer, freezing} (받기 전이면 null) */
export function viewerSections({ v, h, mock }) {
	const n = h?.loss.length || 1800, z = nulls(n);
	const L = [C().bad, C().warn, C().ok];
	const marks = []; (h?.freezing ?? []).forEach((f, k) => { if (f === 1 && (k === 0 || h.freezing[k - 1] !== 1)) marks.push(k); });
	const fpsMock = v.clientReported ? '' : mock;
	return [
		sec('지금', live, gauges([[gauge(v.lossPct, 5, { unit: '%' }), 'Loss'], [gauge(v.rttMs, 200, { unit: 'ms' }), 'RTT'], [gauge(v.fps, 30, { unit: 'fps', c: C().ok }), 'fps' + fpsMock]]), 2),
		sec('Loss 30분', v.lossPct == null ? '—' : f1(v.lossPct) + '%', area(h?.loss ?? z, { c: C().warn, unit: '%', h: 64, tip: ['Loss'] }) + axis(), 2),
		sec('RTT 30분', v.rttMs == null ? '—' : v.rttMs + 'ms', area(h?.rtt ?? z, { unit: 'ms', h: 64, tip: ['RTT'] }) + axis(), 2),
		sec('fps 30분' + fpsMock, v.fps == null ? '—' : f1(v.fps), area(h?.fps ?? z, { c: C().ok, max: 32, h: 64, tip: ['fps'], tipU: ' fps' }) + axis(), 2),
		sec('레이어', v.layerNo == null ? '—' : 'L' + v.layerNo, timeline(h?.layer ?? z, L, { marks, names: ['L0 저화질', 'L1 중간', 'L2 고화질'], tip: '레이어' }) + legend([[L[2], 'L2', 1], [L[1], 'L1', 1], [L[0], 'L0', 1], [C().bad, '| 멈춤']]) + axis(), 4),
	];
}

/* origin 패널: 전체 시청자 + node별. oSel = null(전체 보기) | 'all' | node 이름 */
export function originSections({ total, nodes, oSel }) {
	const cols = [C().acc, C().acc2, C().ok, C().warn, '#5b8cff', '#ff8a5b'];
	const n = nodes[0]?.a.length || 1800;
	const byNode = nodes.map((x, j) => ({ ...x, key: x.n, c: cols[j % cols.length] }));
	const allA = Array.from({ length: n }, (_, k) => { let s = null; for (const x of byNode) if (x.a[k] != null) s = (s ?? 0) + x.a[k]; return s; });
	const all = { n: '전체 시청자', key: 'all', c: C().ink, a: allA, w: 2, now: total };
	const series = [all, ...byNode];
	const shown = oSel ? series.filter(x => x.key === oSel) : series;
	const pick = oSel ? series.find(x => x.key === oSel) : null;
	const row = x => `<div class="k-osel${oSel === x.key ? ' on' : ''}" data-osel="${x.key}" title="${x.n}만 그래프에 표시 (다시 누르면 해제)"><span><i style="background:${x.c}"></i>${x.n}</span><b>${x.now}<small>명</small></b></div>`;
	return [
		sec('시청자', live, `<div class="k-stats">${series.map(row).join('')}</div>`, 2),
		sec('시청자 30분', (pick ? `${pick.n} ${pick.now}명` : `합계 ${total}명`) + `<button class="k-mini${oSel ? '' : ' on'}" data-osel="">전체 보기</button>`, lines(shown.map(x => ({ ...x, step: 1 })), { h: 96, unit: '명', tip: 1 }) + legend(shown.map(x => [x.c, x.n])) + axis(), 4),
	];
}

/* 송출자 패널 */
export function senderSections({ sending, idle }) {
	const row = (t, v) => `<div><span>${t}</span><b>${v}<small>명</small></b></div>`;
	return [sec('송출자', live, `<div class="k-stats">${row('송출 중', sending)}${row('대기 (송출 없음)', idle)}</div>`, 2)];
}

/* 그래프 마우스 값: data-tip이 있는 그래프 위에서 가장 가까운 칸 */
document.addEventListener('mousemove', e => {
	const w = e.target.closest && e.target.closest('.k-cw[data-tip]');
	document.querySelectorAll('.k-cw.tip-on').forEach(x => x !== w && x.classList.remove('tip-on'));
	if (!w) return;
	const t = TIPS.get(+w.dataset.tip);
	if (!t) return;
	const rc = w.getBoundingClientRect(), n = t.s[0].a.length, fx = (e.clientX - rc.left) / rc.width;
	const k = t.b ? Math.min(n - 1, Math.max(0, Math.floor(fx * n))) : Math.min(n - 1, Math.max(0, Math.round(fx * (n - 1))));
	const px = t.b ? ((k + 0.5) / n) * rc.width : (k / Math.max(1, n - 1)) * rc.width;
	const tip = w.querySelector('.k-tip');
	tip.innerHTML = `<b>${ago(n - 1 - k)}</b>` + t.s.map(x => `<span><i style="background:${x.c}"></i>${x.n} <b>${x.a[k] == null ? '—' : typeof x.a[k] === 'string' ? x.a[k] : f1(x.a[k]) + t.u}</b></span>`).join('');
	w.querySelector('.k-tipl').style.left = px + 'px';
	tip.style.left = Math.min(Math.max(px - 60, 0), rc.width - 130) + 'px';
	w.classList.add('tip-on');
});
