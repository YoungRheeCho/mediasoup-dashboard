/* 선택 패널 시안 키트: 예시 데이터 + SVG 차트 + 구성(content) 10종 + 배치(layout)는 kit.css.
 * 바탕 시안(central-overview-3d.html)의 renderDetail()이 window.__V.detail(el, ctx)를 부른다.
 * window.__CFG = { layout, content, theme, title } 는 각 시안 파일이 넣는다. */
(() => {
	const CFG = window.__CFG || { layout: 'dock', content: 'kpi' };
	const N = 61; // 30분, 30초 간격 (+ 지금)
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
	const last = a => a[a.length - 1];
	const avg = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
	const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
	const rng = seed => { let a = seed || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
	const walk = (r, n, base, vol, lo, hi, rev = 0.15) => { const a = []; let x = base; for (let i = 0; i < n; i++) { x += (base - x) * rev + (r() - 0.5) * vol; a.push(clamp(x, lo, hi)); } return a; };
	const f1 = v => (v == null || isNaN(v) ? '—' : Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString());
	const fBps = b => (b >= 1e6 ? (b / 1e6).toFixed(1) + '<small>Mbps</small>' : Math.round(b / 1e3) + '<small>kbps</small>');
	const fBpsT = b => (b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbps' : Math.round(b / 1e3) + ' kbps');
	const ago = k => { const s = (N - 1 - k) * 30; return s === 0 ? '지금' : s < 60 ? s + '초 전' : Math.floor(s / 60) + '분 전'; };
	const css = n => getComputedStyle(document.body).getPropertyValue(n).trim() || null;
	const C = () => ({ acc: css('--acc') || '#2cd9ff', acc2: css('--acc2') || '#a78bfa', ok: css('--ok') || '#01b574', warn: css('--warn') || '#ffb547', bad: css('--bad') || '#ff4d6d', grid: css('--grid') || '#ffffff14', axis: css('--axis') || '#ffffff26', muted: css('--muted') || '#a0aec0', ink: css('--ink') || '#fff' });
	let uid = 0;

	/* ================= 예시 데이터 ================= */
	const store = new Map();
	const LAYER_BPS = [2.4e5, 9e5, 2.6e6];
	function edgeData(e, i, ctx) {
		const key = 'e:' + e.name;
		if (store.has(key)) return store.get(key);
		const r = rng(hash(e.name));
		const cpu = walk(r, N, e.cpu + 12, 7, 4, 88);
		const b0 = 22 + Math.floor(r() * 18);
		for (let k = 0; k < 9; k++) cpu[b0 + k] = clamp(cpu[b0 + k] + 30 * Math.sin((k / 8) * Math.PI), 4, 96);
		const peak = cpu.map(v => clamp(v + 12 + r() * (v > 45 ? 45 : 25), v, 100));
		const thr = peak.map(p => (p > 93 ? Math.round(8 + r() * 70) : 0));
		const n = ctx.edgeCount(i) || 3 + Math.floor(r() * 6);
		const vw = []; let x = Math.max(0, n - 4 - Math.floor(r() * 4));
		for (let k = 0; k < N; k++) { if (r() < 0.12 && x < n) x++; if (r() < 0.03 && x > 0) x--; vw.push(k === N - 1 ? n : x); }
		const l2 = [], l1 = [], l0 = [];
		vw.forEach((v, k) => { const bad = clamp((cpu[k] - 55) / 40, 0, 0.6); const a = Math.round(v * (0.65 - bad * 0.5)), b = Math.round(v * (0.25 + bad * 0.3)); l2.push(a); l1.push(Math.min(b, v - a)); l0.push(Math.max(0, v - a - b)); });
		const d = {
			kind: 'edge', name: e.name, color: e.color, cpu, peak, thr, vw, l2, l1, l0,
			egress: vw.map((v, k) => v * (l2[k] / Math.max(1, v) * 2.4e6 + 0.6e6) * (0.9 + r() * 0.2)),
			loss: walk(r, N, 0.5, 0.5, 0, 4), rtt: walk(r, N, 34, 9, 12, 140), lag: walk(r, N, 4, 3, 0.4, 45), worker: cpu.map(v => v * 0.55 + r() * 4),
			limit: 2, pid: 'mediasoup-edge-' + (hash(e.name) % 0xfffff).toString(16),
		};
		store.set(key, d);
		return d;
	}
	function viewerData(v, i) {
		const key = 'v:' + v.name;
		if (store.has(key)) return store.get(key);
		const r = rng(hash(v.name));
		const lossNow = parseFloat(v.loss) || 0, rttNow = parseInt(v.rtt) || 30, layerNow = +String(v.layer)[1] || 0;
		const loss = walk(r, N, lossNow, 0.7, 0, 7); loss[N - 1] = lossNow;
		const rtt = walk(r, N, rttNow, 10, 10, 180); rtt[N - 1] = rttNow;
		const jit = walk(r, N, 6 + lossNow * 4, 4, 0.5, 60);
		const layer = []; let L = 2;
		for (let k = 0; k < N; k++) { if (loss[k] > 1.6 && L > 0 && r() < 0.5) L--; else if (loss[k] < 0.6 && L < 2 && r() < 0.25) L++; layer.push(k > N - 4 ? layerNow : L); }
		const fps = layer.map((l, k) => clamp(30 - (2 - l) * 3 - loss[k] * 1.5 + (r() - 0.5) * 3, 0, 30));
		const freezes = [];
		const nf = String(v.freeze || '').startsWith('1') ? 1 : r() < 0.3 ? 1 : 0;
		for (let f = 0; f < nf + (lossNow > 1 ? 1 : 0); f++) { const k = 15 + Math.floor(r() * 40); freezes.push(k); fps[k] = 0; fps[k + 1] = 4; }
		const pts = v.points || [v.late];
		const late = Array.from({ length: N }, (_, k) => { const t = (k / (N - 1)) * (pts.length - 1), a = Math.floor(t), b = Math.min(pts.length - 1, a + 1); return clamp(pts[a] + (pts[b] - pts[a]) * (t - a) + (r() - 0.5) * 0.25, 0, 5); });
		late[N - 1] = v.late;
		const bps = layer.map((l, k) => LAYER_BPS[l] * (0.85 + r() * 0.3) * (1 - loss[k] / 20));
		const joined = 10 + Math.floor(r() * 50);
		const events = [{ k: N - 1 - Math.min(N - 1, joined), t: 'join', txt: '입장 · 레이어 L2 시작' }];
		for (let k = 1; k < N; k++) if (layer[k] !== layer[k - 1]) events.push({ k, t: layer[k] < layer[k - 1] ? 'down' : 'up', txt: `레이어 L${layer[k - 1]} → L${layer[k]}` });
		freezes.forEach(k => events.push({ k, t: 'freeze', txt: '영상 멈춤 ' + (1 + Math.floor(r() * 3)) + '초' }));
		loss.forEach((l, k) => { if (l > 3 && (k === 0 || loss[k - 1] <= 3)) events.push({ k, t: 'loss', txt: `패킷 loss ${l.toFixed(1)}%` }); });
		const joinK = events[0].k;
		events.splice(0, events.length, ...events.filter((e, q) => q === 0 || e.k > joinK)); // 입장 전 이벤트는 없다
		events.sort((a, b) => a.k - b.k);
		const d = { kind: 'viewer', name: v.name, loss, rtt, jit, fps, layer, late, bps, freezes, events, joined, browser: ['Chrome 131', 'Safari 18', 'Edge 131', 'Firefox 133'][hash(v.name) % 4], net: ['Wi-Fi', 'LTE', '유선', '5G'][hash(v.name) % 4] };
		store.set(key, d);
		return d;
	}
	function score(d) {
		const s = 100 - last(d.loss) * 9 - Math.max(0, last(d.rtt) - 50) * 0.35 - last(d.late) * 7 - d.freezes.length * 6 - (2 - last(d.layer)) * 7 - Math.max(0, 25 - last(d.fps)) * 1.2;
		return Math.round(clamp(s, 0, 100));
	}
	const grade = s => (s >= 85 ? ['좋음', 'ok'] : s >= 65 ? ['보통', 'warn'] : ['나쁨', 'bad']);
	function tick() { // 2초마다 새 값 (예시 실시간)
		for (const d of store.values()) {
			const r = Math.random;
			const push = (a, v) => { a.push(v); a.shift(); };
			if (d.kind === 'edge') {
				const c = clamp(last(d.cpu) + (40 - last(d.cpu)) * 0.1 + (r() - 0.5) * 8, 3, 97);
				push(d.cpu, c); const p = clamp(c + 10 + r() * 40, c, 100); push(d.peak, p); push(d.thr, p > 93 ? Math.round(8 + r() * 60) : 0);
				push(d.vw, last(d.vw)); push(d.l2, last(d.l2)); push(d.l1, last(d.l1)); push(d.l0, last(d.l0));
				push(d.egress, last(d.egress) * (0.95 + r() * 0.1)); push(d.loss, clamp(last(d.loss) + (r() - 0.5) * 0.5, 0, 4)); push(d.rtt, clamp(last(d.rtt) + (r() - 0.5) * 8, 12, 140)); push(d.lag, clamp(last(d.lag) + (r() - 0.5) * 3, 0.4, 45)); push(d.worker, c * 0.55 + r() * 4);
			} else {
				push(d.loss, clamp(last(d.loss) + (r() - 0.5) * 0.4, 0, 7)); push(d.rtt, clamp(last(d.rtt) + (r() - 0.5) * 6, 10, 180)); push(d.jit, clamp(last(d.jit) + (r() - 0.5) * 3, 0.5, 60));
				push(d.fps, clamp(last(d.fps) + (r() - 0.5) * 3, 0, 30)); push(d.layer, last(d.layer)); push(d.late, clamp(last(d.late) + (r() - 0.5) * 0.3, 0, 5)); push(d.bps, last(d.bps) * (0.95 + r() * 0.1));
				d.events.forEach(e => e.k--); d.events = d.events.filter(e => e.k >= 0); d.freezes = d.freezes.map(k => k - 1).filter(k => k >= 0);
			}
		}
	}

	/* ================= SVG 차트 ================= */
	const W = 320;
	const xs = (n, w = W) => i => (n <= 1 ? 0 : (i / (n - 1)) * w);
	const pathOf = (a, x, y, step) => a.map((v, i) => (i ? (step ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`) : `M0 ${y(v).toFixed(1)}`)).join('');
	const smooth = (a, x, y) => { let d = `M0 ${y(a[0]).toFixed(1)}`; for (let i = 1; i < a.length; i++) { const x0 = x(i - 1), x1 = x(i), m = (x0 + x1) / 2; d += ` C${m.toFixed(1)} ${y(a[i - 1]).toFixed(1)} ${m.toFixed(1)} ${y(a[i]).toFixed(1)} ${x1.toFixed(1)} ${y(a[i]).toFixed(1)}`; } return d; };
	const gridLines = (h, max, y, unit) => { const c = C(); return `<path d="M0 ${y(max / 2)}H${W}M0 ${y(max)}H${W}" stroke="${c.grid}" stroke-dasharray="3 3"/><path d="M0 ${y(0)}H${W}" stroke="${c.axis}"/><!--YL:${max}${unit || ''}-->`; };
	// 가로로 늘어나는 SVG 안에는 글자를 두지 않는다. <!--YL:..-->(왼쪽 위 최대값)·<!--TH:y|글자|색-->(임계선 글자)는 HTML로 겹쳐 그린다.
	const svg = (h, body, label, tip) => {
		const tags = [];
		body = body.replace(/<!--YL:(.*?)-->/g, (_, t) => (tags.push(`<span class="k-yl">${t}</span>`), '')).replace(/<!--TH:(.*?)\|(.*?)\|(.*?)-->/g, (_, y, t, c) => (tags.push(`<span class="k-thl" style="top:${(+y + 2 - 13).toFixed(0)}px;color:${c}">${t}</span>`), ''));
		const el = `<svg class="k-chart" viewBox="0 -2 ${W} ${h + 4}" preserveAspectRatio="none" style="height:${h + 4}px" role="img" aria-label="${label || ''}">${body}</svg>`;
		if (tip) return `<div class="k-cw" data-tip='${JSON.stringify(tip).replace(/'/g, '&#39;')}'>${el}${tags.join('')}<i class="k-tipl"></i><div class="k-tip"></div></div>`;
		return tags.length ? `<div class="k-cw">${el}${tags.join('')}</div>` : el;
	};
	const grad = (c, o = 0.38) => { const id = 'kg' + ++uid; return [id, `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>`]; };

	function area(a, o = {}) {
		const h = o.h || 72, max = o.max || Math.max(1, Math.ceil(Math.max(...a, ...(o.over || [])) * 1.15)), c = o.c || C().acc;
		const x = xs(a.length), y = v => h - 2 - (clamp(v, 0, max) / max) * (h - 8);
		const [id, def] = grad(c);
		const line = o.step ? pathOf(a, x, y, true) : smooth(a, x, y);
		let extra = '';
		if (o.over) extra += `<path d="${o.step ? pathOf(o.over, x, y, true) : smooth(o.over, x, y)}" fill="none" stroke="${o.overC || C().bad}" stroke-width="1.3" stroke-dasharray="3 2" opacity=".9" vector-effect="non-scaling-stroke"/>`;
		if (o.th != null) { const tc = o.thC || C().warn; extra += `<path d="M0 ${y(o.th)}H${W}" stroke="${tc}" stroke-width="${o.thW || 1}" stroke-dasharray="${o.thW ? '6 4' : '5 3'}" opacity="${o.thW ? 1 : 0.8}" vector-effect="non-scaling-stroke"/><!--TH:${y(o.th)}|${o.thLabel || o.th}|${tc}-->`; }
		if (o.marks) extra += o.marks.map(k => `<circle cx="${x(k)}" cy="${y(a[k])}" r="3.2" fill="${C().bad}" stroke="#0008"/>`).join('');
		const dot = `<circle cx="${x(a.length - 1)}" cy="${y(last(a))}" r="3" fill="${c}" stroke="#fff" stroke-width="1.2"/>`;
		const gl = gridLines(h, max, y, o.unit); // 임계선이 최대값 자리에 있으면 왼쪽 위 최대 라벨은 겹치니 뺀다
		return svg(h, def + (o.th != null && o.th >= max ? gl.replace(/<!--YL:.*?-->/, '') : gl) + `<path d="${line} L${W} ${h} L0 ${h} Z" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` + extra + dot, o.label, o.tip ? { u: o.tipU ?? o.unit ?? '', s: [{ n: o.tip[0], c, a: a.map(v => +v.toFixed(1)) }, ...(o.over ? [{ n: o.tip[1] || '', c: o.overC || C().bad, a: o.over.map(v => +v.toFixed(1)) }] : [])] } : null);
	}
	function lines(list, o = {}) {
		const h = o.h || 72, max = o.max || Math.max(1, Math.ceil(Math.max(...list.flatMap(l => l.a)) * 1.15));
		const x = xs(list[0].a.length), y = v => h - 2 - (clamp(v, 0, max) / max) * (h - 8);
		const gl = gridLines(h, max, y, o.unit);
		return svg(h, (o.th != null && o.th >= max ? gl.replace(/<!--YL:.*?-->/, '') : gl) + list.map(l => `<path d="${l.step ? pathOf(l.a, x, y, true) : smooth(l.a, x, y)}" fill="none" stroke="${l.c}" stroke-width="${l.w || 1.8}" ${l.dash ? 'stroke-dasharray="4 3"' : ''} opacity="${l.o || 1}" vector-effect="non-scaling-stroke"/>`).join('') + (o.th != null ? `<path d="M0 ${y(o.th)}H${W}" stroke="${o.thC || C().warn}" stroke-width="${o.thW || 1}" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/><!--TH:${y(o.th)}|${o.thLabel || o.th}|${o.thC || C().warn}-->` : ''), o.label, o.tip ? { u: o.tipU ?? o.unit ?? '', s: list.map(l => ({ n: l.n || '', c: l.c, a: l.a.map(v => +v.toFixed(1)) })) } : null);
	}
	function band(lo, hi, mid, o = {}) {
		const h = o.h || 72, max = o.max || Math.ceil(Math.max(...hi) * 1.1), c = o.c || C().acc;
		const x = xs(mid.length), y = v => h - 2 - (clamp(v, 0, max) / max) * (h - 8);
		const up = hi.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(''), dn = lo.map((v, i) => `L${x(lo.length - 1 - i).toFixed(1)} ${y(lo[lo.length - 1 - i]).toFixed(1)}`).join('');
		return svg(h, gridLines(h, max, y, o.unit) + `<path d="${up}${dn}Z" fill="${c}" opacity=".18"/><path d="${smooth(mid, x, y)}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/>` + (o.me ? `<path d="${smooth(o.me, x, y)}" fill="none" stroke="${o.meC || C().warn}" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''), o.label);
	}
	function bars(a, o = {}) {
		const h = o.h || 56, max = o.max || Math.max(1, Math.max(...a) * 1.1), n = a.length, bw = W / n, c = o.c || C().acc;
		return svg(h, a.map((v, i) => { const bh = Math.max(v > 0 ? 1.5 : 0, (v / max) * (h - 4)); const hot = o.hot != null && v >= o.hot; return `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${hot ? C().bad : c}" opacity="${i === n - 1 ? 1 : 0.75}"><title>${ago(i + (N - n))} · ${f1(v)}${o.unit || ''}</title></rect>`; }).join(''), o.label, o.tip ? { b: 1, u: o.tipU ?? o.unit ?? '', s: [{ n: o.tip, c, a: a.map(v => +(+v).toFixed(1)) }] } : null);
	}
	function stack(list, o = {}) {
		const h = o.h || 72, n = list[0].a.length, tot = Array.from({ length: n }, (_, i) => list.reduce((s, l) => s + l.a[i], 0)), max = o.max || Math.max(1, Math.max(...tot) * 1.1);
		const x = xs(n), y = v => h - 2 - (v / max) * (h - 8);
		let base = Array(n).fill(0), out = gridLines(h, Math.round(max), y, o.unit);
		for (const l of list) { const top = base.map((b, i) => b + l.a[i]); const up = top.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(''), dn = base.map((v, i) => `L${x(n - 1 - i).toFixed(1)} ${y(base[n - 1 - i]).toFixed(1)}`).join(''); out += `<path d="${up}${dn}Z" fill="${l.c}" opacity=".75"/>`; base = top; }
		return svg(h, out, o.label, o.tip ? { u: o.tipU ?? o.unit ?? '', s: [{ n: '합계', c: C().ink, a: tot }, ...list.map(l => ({ n: l.n || '', c: l.c, a: l.a }))] } : null);
	}
	function heat(a, o = {}) {
		const h = o.h || 16, max = o.max || Math.max(...a, 1), n = a.length, bw = W / n, c = o.c || C().acc;
		return svg(h, a.map((v, i) => `<rect x="${(i * bw).toFixed(2)}" y="0" width="${(bw - 0.6).toFixed(2)}" height="${h}" rx="1.5" fill="${o.bad != null && v >= o.bad ? C().bad : c}" opacity="${(0.08 + 0.92 * clamp(v / max, 0, 1)).toFixed(2)}"><title>${ago(i)} · ${f1(v)}${o.unit || ''}</title></rect>`).join(''), o.label);
	}
	function hist(vals, edges, o = {}) {
		const cnt = edges.slice(0, -1).map((lo, k) => vals.filter(v => v >= lo && (k === edges.length - 2 ? v <= edges[k + 1] : v < edges[k + 1])).length);
		const h = o.h || 60, max = Math.max(1, ...cnt), bw = W / cnt.length;
		return svg(h, cnt.map((v, i) => { const bh = (v / max) * (h - 14); const col = o.colors ? o.colors[i] : o.c || C().acc; return `<rect x="${i * bw + 3}" y="${h - 12 - bh}" width="${bw - 6}" height="${bh}" rx="3" fill="${col}" opacity=".85"/><text x="${i * bw + bw / 2}" y="${h - 14 - bh - 2}" text-anchor="middle" font-size="9" font-weight="800" fill="${C().ink}">${v || ''}</text><text x="${i * bw + bw / 2}" y="${h}" text-anchor="middle" font-size="8.5" fill="${C().muted}" font-weight="700">${o.labels ? o.labels[i] : edges[i]}</text>`; }).join(''), o.label);
	}
	function donut(parts, o = {}) {
		const s = o.size || 96, r = s / 2 - 8, cx = s / 2, tot = parts.reduce((a, p) => a + p.v, 0) || 1, circ = 2 * Math.PI * r; let off = 0;
		const segs = parts.map(p => { const len = (p.v / tot) * circ; const seg = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${p.c}" stroke-width="${o.w || 11}" stroke-dasharray="${Math.max(0, len - 2)} ${circ}" stroke-dashoffset="${-off}" transform="rotate(-90 ${cx} ${cx})"><title>${p.label} ${p.v}</title></circle>`; off += len; return seg; }).join('');
		return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${C().grid}" stroke-width="${o.w || 11}"/>${segs}<text x="${cx}" y="${cx + 2}" text-anchor="middle" font-size="${o.fs || 17}" font-weight="800" fill="${C().ink}">${o.center ?? tot}</text>${o.sub ? `<text x="${cx}" y="${cx + 15}" text-anchor="middle" font-size="9" font-weight="700" fill="${C().muted}">${o.sub}</text>` : ''}</svg>`;
	}
	function gauge(v, max, o = {}) {
		const s = o.size || 92, r = s / 2 - 8, cx = s / 2, cy = s / 2 + 4, p = clamp(v / max, 0, 1), c = o.c || (p > 0.85 ? C().bad : p > 0.65 ? C().warn : C().acc);
		const arc = t => { const a = Math.PI * (1 - t); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
		const [x0, y0] = arc(0), [x1, y1] = arc(p), [x2, y2] = arc(1);
		return `<svg width="${s}" height="${s * 0.7}" viewBox="0 0 ${s} ${s * 0.7}"><path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="${C().grid}" stroke-width="9" stroke-linecap="round"/><path d="M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" style="filter:drop-shadow(0 0 5px ${c})"/><text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="16" font-weight="800" fill="${C().ink}">${o.text ?? f1(v)}<tspan font-size="9" fill="${C().muted}">${o.unit || ''}</tspan></text></svg>`;
	}
	function ring(v, o = {}) {
		const s = o.size || 84, r = s / 2 - 7, cx = s / 2, circ = 2 * Math.PI * r, c = o.c || (v >= 85 ? C().ok : v >= 65 ? C().warn : C().bad);
		return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${C().grid}" stroke-width="8"/><circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(v / 100) * circ} ${circ}" transform="rotate(-90 ${cx} ${cx})" style="filter:drop-shadow(0 0 6px ${c})"/><text x="${cx}" y="${cx + 6}" text-anchor="middle" font-size="${o.fs || 22}" font-weight="800" fill="${C().ink}">${v}</text>${o.sub ? `<text x="${cx}" y="${cx + 19}" text-anchor="middle" font-size="8.5" font-weight="700" fill="${C().muted}">${o.sub}</text>` : ''}</svg>`;
	}
	function bullet(v, o = {}) {
		const max = o.max || 100, h = 22, x = t => (clamp(t, 0, max) / max) * W, c = o.c || C().acc;
		return svg(h, `<rect x="0" y="5" width="${W}" height="12" rx="6" fill="${C().grid}"/>${o.p90 != null ? `<rect x="0" y="5" width="${x(o.p90)}" height="12" rx="6" fill="${C().axis}"/>` : ''}<rect x="0" y="8" width="${x(v)}" height="6" rx="3" fill="${c}"/>${o.avg != null ? `<rect x="${x(o.avg) - 1}" y="1" width="2.5" height="20" rx="1" fill="${C().ink}"/>` : ''}`, o.label);
	}
	function timeline(states, colors, o = {}) {
		const h = o.h || 18, n = states.length, bw = W / n;
		let out = '', s0 = 0;
		for (let i = 1; i <= n; i++) if (i === n || states[i] !== states[s0]) { out += `<rect x="${(s0 * bw).toFixed(1)}" y="0" width="${((i - s0) * bw - 1).toFixed(1)}" height="${h}" rx="3" fill="${colors[states[s0]]}"><title>${o.names ? o.names[states[s0]] : states[s0]} · ${ago(s0)}~${ago(i - 1)}</title></rect>`; s0 = i; }
		if (o.marks) out += o.marks.map(k => `<path d="M${k * bw + bw / 2} -1V${h + 1}" stroke="${C().bad}" stroke-width="2.5"/>`).join('');
		return svg(h, out, o.label, o.tip ? { b: 1, u: '', s: [{ n: o.tip, c: C().muted, a: states.map((st, k) => (o.names ? o.names[st] : String(st)) + ((o.marks || []).includes(k) ? ' · 멈춤' : '')) }] } : null);
	}
	function radar(axes, o = {}) {
		const s = o.size || 170, cx = s / 2, cy = s / 2 + 4, r = s / 2 - 26, n = axes.length, c = o.c || C().acc;
		const pt = (k, t) => { const a = -Math.PI / 2 + (k / n) * 2 * Math.PI; return [cx + r * t * Math.cos(a), cy + r * t * Math.sin(a)]; };
		const ringP = t => axes.map((_, k) => pt(k, t).map(v => v.toFixed(1)).join(',')).join(' ');
		const poly = l => l.map((v, k) => pt(k, clamp(v, 0.04, 1)).map(q => q.toFixed(1)).join(',')).join(' ');
		return `<svg width="100%" height="${s}" viewBox="0 0 ${s} ${s}">${[0.25, 0.5, 0.75, 1].map(t => `<polygon points="${ringP(t)}" fill="none" stroke="${C().grid}"/>`).join('')}${axes.map((ax, k) => { const [x, y] = pt(k, 1.18); return `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="9" font-weight="800" fill="${C().muted}">${ax.label}</text>`; }).join('')}${o.ref ? `<polygon points="${poly(o.ref)}" fill="none" stroke="${C().muted}" stroke-dasharray="3 2"/>` : ''}<polygon points="${poly(axes.map(a => a.v))}" fill="${c}" fill-opacity=".25" stroke="${c}" stroke-width="2"/></svg>`;
	}
	function spark(a, o = {}) { const h = o.h || 22, max = o.max || Math.max(...a, 1) * 1.1, x = xs(a.length), y = v => h - 1 - (v / max) * (h - 3); return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="height:${h}px;width:100%"><path d="${smooth(a, x, y)}" fill="none" stroke="${o.c || C().acc}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`; }
	function micro(a, o = {}) { const n = 14, step = Math.floor(a.length / n), pts = Array.from({ length: n }, (_, i) => avg(a.slice(i * step, (i + 1) * step))); return bars(pts, { h: o.h || 26, c: o.c, max: o.max }); }
	function box(vals, me, o = {}) {
		const s = [...vals].sort((a, b) => a - b), q = p => s[Math.floor(p * (s.length - 1))], max = o.max || Math.max(...s, me) * 1.1, x = v => (v / max) * W, h = 30, c = o.c || C().acc;
		return svg(h, `<path d="M${x(q(0))} 15H${x(q(1))}" stroke="${C().axis}" stroke-width="1.5"/><rect x="${x(q(0.25))}" y="7" width="${Math.max(2, x(q(0.75)) - x(q(0.25)))}" height="16" rx="3" fill="${c}" opacity=".3" stroke="${c}"/><path d="M${x(q(0.5))} 5V25" stroke="${c}" stroke-width="2"/><circle cx="${x(me)}" cy="15" r="5" fill="${C().warn}" stroke="#000a"/>`, o.label);
	}

	/* ================= 공통 조각 ================= */
	const axis = () => `<div class="k-axis"><span>30분 전</span><span>15분 전</span><span>지금</span></div>`;
	const sec = (title, right, body, opt = {}) => ({ html: `<h4><span>${title}</span>${right ? `<em>${right}</em>` : ''}</h4>${body}`, ...opt });
	const kpi = (label, val, o = {}) => `<div class="k-kpi" title="${label} · 화살표는 5분 전 대비"><span>${label}</span><strong>${val}</strong>${o.d != null ? `<span class="d ${o.d > 0.5 ? (o.goodUp ? 'dn' : 'up') : o.d < -0.5 ? (o.goodUp ? 'up' : 'dn') : 'eq'}">${o.d > 0 ? '▲' : o.d < 0 ? '▼' : '■'} ${f1(Math.abs(o.d))}${o.du || ''}</span>` : ''}${o.spark || ''}</div>`;
	const kpis = (items, cols) => ({ html: `<div class="k-kpis" style="--kc:${cols || items.length}">${items.join('')}</div>`, raw: true, span: 6, tab: 0 });
	const legend = items => `<div class="k-legend">${items.map(([c, t, box]) => `<span><i class="${box ? 'box' : ''}" style="--c:${c}"></i>${t}</span>`).join('')}</div>`;
	const d5 = a => last(a) - a[a.length - 11];
	const pill = (txt, kind) => `<span class="k-pill" style="--pc:var(--${kind})">${txt}</span>`;
	const LCOL = () => [C().bad, C().warn, C().ok];
	const viewersOf = (ctx, i) => ctx.VIEWERS.map((v, k) => ({ v, k })).filter(o => o.v.edge === i && !o.v.joining);
	const vlist = (ctx, i, n = 5) => {
		const list = viewersOf(ctx, i).map(o => ({ ...o, d: viewerData(o.v, o.k) })).map(o => ({ ...o, s: score(o.d) })).sort((a, b) => a.s - b.s).slice(0, n);
		return `<div class="k-list">${list.map(o => { const [g, k] = grade(o.s); return `<div class="k-li" data-pick="viewer:${o.k}"><div><b>${o.v.name}</b> <span class="sub">· L${last(o.d.layer)} · loss ${f1(last(o.d.loss))}%</span><div class="bar"><i style="--c:var(--${k});width:${o.s}%"></i></div></div><span class="k-pill" style="--pc:var(--${k})">${o.s} ${g}</span></div>`; }).join('') || '<div class="sub">시청자 없음</div>'}</div>`;
	};
	const fleet = ctx => ctx.EDGES.map((e, i) => edgeData(e, i, ctx));

	/* ================= 구성(content) 10종 =================
	 * 각 구성은 edge(서버)와 viewer(시청자) 섹션 목록을 돌려준다. tab은 탭형 배치에서 쓰는 묶음(0=개요). span은 bento 폭(6칸 중). */
	const TABS = { edge: ['개요', '자원', '네트워크', '시청자'], viewer: ['개요', '품질', '재생', '이력'], other: ['개요'] };
	const SETS = {};

	// 1) kpi: KPI 타일 + 영역 그래프 (가장 기본)
	SETS.kpi = {
		edge: (d, ctx, i) => [
			kpis([kpi('CPU 평균', f1(last(d.cpu)) + '<small>%</small>', { d: d5(d.cpu), du: '%p' }), kpi('1초 최대', f1(last(d.peak)) + '<small>%</small>', { d: d5(d.peak), du: '%p' }), kpi('시청자', last(d.vw) + '<small>명</small>', { d: d5(d.vw), goodUp: true }), kpi('송신', fBps(last(d.egress)))]),
			sec('CPU · 평균과 1초 최대', 'throttle ' + d.thr.filter(v => v > 0).length + '회', area(d.cpu, { max: 100, unit: '%', over: d.peak, th: 90, thLabel: '90%', marks: d.thr.map((v, k) => (v ? k : -1)).filter(k => k >= 0) }) + legend([[C().acc, '평균'], [C().bad, '1초 최대']]) + axis(), { tab: 1, span: 4 }),
			sec('시청자 수', last(d.vw) + '명', area(d.vw, { step: true, c: C().acc2, unit: '명' }) + axis(), { tab: 3, span: 2 }),
			sec('송신 비트레이트', fBpsT(last(d.egress)), area(d.egress.map(v => v / 1e6), { c: C().ok, unit: 'M' }) + axis(), { tab: 2, span: 3 }),
			sec('시청자 평균 loss · RTT', f1(last(d.loss)) + '% · ' + Math.round(last(d.rtt)) + 'ms', lines([{ a: d.loss.map(v => v * 25), c: C().warn }, { a: d.rtt, c: C().acc2, dash: true }], { max: 150 }) + legend([[C().warn, 'loss ×25'], [C().acc2, 'RTT ms']]), { tab: 2, span: 3 }),
			sec('주의할 시청자', '점수 낮은 순', vlist(ctx, i), { tab: 3, span: 6 }),
		],
		viewer: (d, ctx) => [
			kpis([kpi('Loss', f1(last(d.loss)) + '<small>%</small>', { d: d5(d.loss), du: '%p' }), kpi('RTT', Math.round(last(d.rtt)) + '<small>ms</small>', { d: d5(d.rtt), du: 'ms' }), kpi('수신', fBps(last(d.bps))), kpi('fps', f1(last(d.fps)), { d: d5(d.fps), goodUp: true })]),
			sec('수신 레이어', 'L' + last(d.layer), timeline(d.layer, LCOL(), { names: ['L0 Low', 'L1 Mid', 'L2 High'], marks: d.freezes }) + legend([[C().ok, 'L2 High', 1], [C().warn, 'L1 Mid', 1], [C().bad, 'L0 Low', 1], [C().bad, '| freeze']]) + axis(), { tab: 2, span: 6 }),
			sec('Loss', f1(last(d.loss)) + '%', area(d.loss, { c: C().warn, unit: '%', th: 2, thLabel: '경고 2%' }) + axis(), { tab: 1, span: 3 }),
			sec('RTT · Jitter', Math.round(last(d.rtt)) + ' / ' + Math.round(last(d.jit)) + 'ms', lines([{ a: d.rtt, c: C().acc }, { a: d.jit, c: C().acc2 }]) + legend([[C().acc, 'RTT'], [C().acc2, 'Jitter']]) + axis(), { tab: 1, span: 3 }),
			sec('수신 비트레이트', fBpsT(last(d.bps)), area(d.bps.map(v => v / 1e6), { c: C().ok, unit: 'M', step: true }) + axis(), { tab: 2, span: 3 }),
			sec('LATE 비율', f1(last(d.late)) + '%', area(d.late, { c: C().warn, unit: '%', max: 5, th: 2 }) + axis(), { tab: 3, span: 3 }),
		],
	};
	// 2) gauge: 게이지 + 스파크라인
	SETS.gauge = {
		edge: (d, ctx, i) => [
			sec('지금', `<span class="k-live">LIVE</span>`, `<div class="k-gauges" style="--gc:3"><figure>${gauge(last(d.cpu), 100, { unit: '%' })}<figcaption>CPU 평균</figcaption></figure><figure>${gauge(last(d.peak), 100, { unit: '%' })}<figcaption>1초 최대</figcaption></figure><figure>${gauge(last(d.vw), Math.max(12, Math.ceil(last(d.vw) * 1.6)), { unit: '명', c: C().acc2, text: last(d.vw) })}<figcaption>시청자 / 적정</figcaption></figure></div>`, { span: 6 }),
			sec('CPU 30분', 'max ' + Math.round(Math.max(...d.peak)) + '%', spark(d.cpu, { h: 30, max: 100 }) + spark(d.peak, { h: 30, max: 100, c: C().bad }) + legend([[C().acc, '평균'], [C().bad, '최대']]), { tab: 1, span: 3 }),
			sec('Throttle (ms/30초)', d.thr.filter(Boolean).length + '구간', bars(d.thr, { c: C().bad, h: 40, unit: 'ms' }) + axis(), { tab: 1, span: 3 }),
			sec('송신', fBpsT(last(d.egress)), spark(d.egress, { h: 34, c: C().ok }), { tab: 2, span: 2 }),
			sec('Event loop 지연', f1(last(d.lag)) + 'ms', spark(d.lag, { h: 34, c: C().warn }), { tab: 1, span: 2 }),
			sec('Worker CPU', f1(last(d.worker)) + '%', spark(d.worker, { h: 34, c: C().acc2 }), { tab: 1, span: 2 }),
			sec('주의할 시청자', '', vlist(ctx, i, 4), { tab: 3, span: 6 }),
		],
		viewer: d => {
			const s = score(d), [g] = grade(s);
			return [
				sec('체감 품질', g, `<div class="k-score">${ring(s, { sub: 'QoE' })}<div class="t"><b>${g} · ${s}점</b>loss·RTT·LATE·freeze·레이어를 합친 예시 점수<br>${d.browser} · ${d.net}</div></div>`, { span: 2 }),
				sec('지금', '', `<div class="k-gauges" style="--gc:3"><figure>${gauge(last(d.loss), 5, { unit: '%' })}<figcaption>Loss</figcaption></figure><figure>${gauge(last(d.rtt), 200, { unit: 'ms' })}<figcaption>RTT</figcaption></figure><figure>${gauge(last(d.fps), 30, { unit: 'fps', c: C().ok })}<figcaption>fps</figcaption></figure></div>`, { span: 4, tab: 1 }),
				sec('Loss', f1(last(d.loss)) + '%', spark(d.loss, { h: 30, c: C().warn }), { tab: 1, span: 2 }),
				sec('RTT', Math.round(last(d.rtt)) + 'ms', spark(d.rtt, { h: 30 }), { tab: 1, span: 2 }),
				sec('fps', f1(last(d.fps)), spark(d.fps, { h: 30, c: C().ok, max: 32 }), { tab: 2, span: 2 }),
				sec('레이어', 'L' + last(d.layer), timeline(d.layer, LCOL(), { marks: d.freezes }) + axis(), { tab: 2, span: 6 }),
			];
		},
	};
	// 2-1) pick: 시안 012(아래 시트) + 002(그래파이트)를 고른 뒤 다듬은 게이지 구성
	// CPU 이용률 = 수집기가 1초마다 보내는 cpuPct (누적 CPU 시간의 1초 Δ ÷ 1초, pod는 CPU 한도 대비).
	// 최대 = 같은 1초 안의 0.1초 값 10개 중 최대 (수집기 lb_model의 cpu_max. 지금 POST에는 없어서 필드 추가 필요). 예시 값은 d.cpu / d.peak.
	SETS.pick = {
		edge: d => {
			return [
			sec('CPU', `<span class="k-live">LIVE</span>`, `<div class="k-gauges" style="--gc:2"><figure>${gauge(last(d.cpu), 100, { unit: '%', size: 104 })}<figcaption>CPU 이용률</figcaption></figure><figure>${gauge(last(d.peak), 100, { unit: '%', size: 104 })}<figcaption>CPU 최대</figcaption></figure></div>`, { span: 2 }),
			sec('CPU 30분', `${f1(last(d.cpu))}% · 최대 ${f1(last(d.peak))}%`, area(d.cpu, { max: 100, unit: '%', over: d.peak, h: 88, th: 100, thLabel: '100%', thW: 0.7, tip: ['이용률', '최대'] }) + legend([[C().acc, '이용률'], [C().bad, '최대']]) + axis(), { span: 4 }),
			sec('시청자 수 30분', last(d.vw) + '명', area(d.vw, { step: true, c: C().acc2, unit: '명', h: 64, tip: ['시청자'] }) + axis(), { span: 2 }),
			sec('Throttle (ms/30초)', d.thr.filter(Boolean).length + '구간', bars(d.thr, { c: C().bad, h: 64, unit: 'ms', tip: 'Throttle' }) + axis(), { span: 2 }),
			sec('송신 비트레이트', fBpsT(last(d.egress)), area(d.egress.map(v => v / 1e6), { c: C().ok, unit: 'M', h: 64, tip: ['송신'], tipU: ' Mbps' }) + axis(), { span: 2 }),
			];
		},
		other: ctx => {
			// origin = 클러스터 전체 시청자만. 값 = 각 중계 서버가 1초마다 보내는 시청자 수를 origin이 더한 것. 그래프는 node별로 쌓는다.
			const fl = fleet(ctx); fl.forEach((d, i) => { const n = ctx.edgeCount(i); if (n) d.vw[N - 1] = n; }); // 지금 시청자 수는 장면과 맞춤
			const names = [...new Set(ctx.EDGES.map(e => e.node || 'node-01'))], cols = [C().acc, C().acc2, C().ok, C().warn];
			const byNode = names.map((nm, j) => ({ n: nm, c: cols[j % cols.length], a: Array.from({ length: N }, (_, k) => ctx.EDGES.reduce((s, e, i) => s + ((e.node || 'node-01') === nm ? fl[i].vw[k] : 0), 0)) }));
			const total = byNode.reduce((s, x) => s + last(x.a), 0);
			const all = { n: '전체', key: 'all', c: C().ink, a: byNode[0].a.map((_, k) => byNode.reduce((t, x) => t + x.a[k], 0)), w: 2 };
			const series = [all, ...byNode.map(x => ({ ...x, key: x.n }))];
			if (oSel && !series.some(x => x.key === oSel)) oSel = null;
			const shown = oSel ? series.filter(x => x.key === oSel) : series;
			const row = x => `<div class="k-osel${oSel === x.key ? ' on' : ''}" data-osel="${x.key}" title="${x.n}만 그래프에 표시 (다시 누르면 해제)"><span><i style="background:${x.c}"></i>${x.n}</span><b>${last(x.a)}<small>명</small></b></div>`;
			const pickT = oSel ? series.find(x => x.key === oSel) : null;
			return [
				sec('시청자', `<span class="k-live">LIVE</span>`, `<div class="k-stats">${row({ ...all, n: '전체 시청자' }) + byNode.map(x => row({ ...x, key: x.n })).join('')}</div>`, { span: 2 }),
				sec('시청자 30분', (pickT ? `${pickT.n} ${last(pickT.a)}명` : '합계 ' + total + '명') + `<button class="k-mini${oSel ? '' : ' on'}" data-osel="">전체 보기</button>`, lines(shown.map(x => ({ ...x, step: 1 })), { h: 96, unit: '명', tip: 1 }) + legend(shown.map(x => [x.c, x.n])) + axis(), { span: 4 }),
			];
		},
		viewer: d => [
			sec('지금', `<span class="k-live">LIVE</span>`, `<div class="k-gauges" style="--gc:3"><figure>${gauge(last(d.loss), 5, { unit: '%' })}<figcaption>Loss</figcaption></figure><figure>${gauge(last(d.rtt), 200, { unit: 'ms' })}<figcaption>RTT</figcaption></figure><figure>${gauge(last(d.fps), 30, { unit: 'fps', c: C().ok })}<figcaption>fps</figcaption></figure></div>`, { span: 2 }),
			sec('Loss 30분', f1(last(d.loss)) + '%', area(d.loss, { c: C().warn, unit: '%', h: 64, tip: ['Loss'] }) + axis(), { span: 2 }),
			sec('RTT 30분', Math.round(last(d.rtt)) + 'ms', area(d.rtt, { unit: 'ms', h: 64, tip: ['RTT'] }) + axis(), { span: 2 }),
			sec('fps 30분', f1(last(d.fps)), area(d.fps, { c: C().ok, max: 32, h: 64, tip: ['fps'], tipU: ' fps' }) + axis(), { span: 2 }),
			sec('레이어', 'L' + last(d.layer), timeline(d.layer, LCOL(), { marks: d.freezes, names: ['L0 저화질', 'L1 중간', 'L2 고화질'], tip: '레이어' }) + legend([[LCOL()[2], 'L2', 1], [LCOL()[1], 'L1', 1], [LCOL()[0], 'L0', 1], [C().bad, '| 멈춤']]) + axis(), { span: 4 }),
		],
	};
	// 3) heat: 30분 히트맵 띠 + 분포
	SETS.heat = {
		edge: (d, ctx, i) => {
			const vs = viewersOf(ctx, i).map(o => o.v.late);
			const ly = [last(d.l0), last(d.l1), last(d.l2)];
			return [
				kpis([kpi('CPU', f1(last(d.cpu)) + '<small>%</small>'), kpi('최대', f1(last(d.peak)) + '<small>%</small>'), kpi('시청자', last(d.vw) + '<small>명</small>')], 3),
				sec('30분 히트맵', '진할수록 높음', ['CPU 평균', 'CPU 최대', 'Throttle', '시청자 loss', 'RTT'].map((t, k) => `<div style="display:grid;grid-template-columns:62px 1fr;align-items:center;gap:6px;margin:3px 0"><span class="sub" style="font-size:10px;font-weight:700">${t}</span>${heat([d.cpu, d.peak, d.thr, d.loss, d.rtt][k], { max: [100, 100, 80, 3, 120][k], c: [C().acc, C().acc, C().bad, C().warn, C().acc2][k], bad: [90, 95, 1, 2.5, 100][k] })}</div>`).join('') + axis(), { span: 4, tab: 1, full: 1 }),
				sec('레이어 분포', '지금', `<div style="display:flex;gap:10px;align-items:center">${donut([{ v: ly[2], c: C().ok, label: 'L2' }, { v: ly[1], c: C().warn, label: 'L1' }, { v: ly[0], c: C().bad, label: 'L0' }], { sub: '명' })}${legend([[C().ok, 'L2 ' + ly[2], 1], [C().warn, 'L1 ' + ly[1], 1], [C().bad, 'L0 ' + ly[0], 1]])}</div>`, { span: 2, tab: 3 }),
				sec('LATE 분포', vs.length + '명', hist(vs, [0, 0.5, 1, 1.5, 2, 3, 6], { labels: ['~.5', '~1', '~1.5', '~2', '~3', '3+'], colors: [C().ok, C().ok, C().acc, C().warn, C().bad, C().bad] }), { span: 3, tab: 3 }),
				sec('주의할 시청자', '', vlist(ctx, i, 3), { span: 3, tab: 3 }),
			];
		},
		viewer: d => [
			kpis([kpi('Loss', f1(last(d.loss)) + '<small>%</small>'), kpi('RTT', Math.round(last(d.rtt)) + '<small>ms</small>'), kpi('fps', f1(last(d.fps)))], 3),
			sec('30분 히트맵', '1칸 = 30초', ['Loss', 'RTT', 'Jitter', 'fps 저하', 'LATE'].map((t, k) => `<div style="display:grid;grid-template-columns:52px 1fr;align-items:center;gap:6px;margin:3px 0"><span class="sub" style="font-size:10px;font-weight:700">${t}</span>${heat([d.loss, d.rtt, d.jit, d.fps.map(v => 30 - v), d.late][k], { max: [4, 150, 40, 30, 4][k], c: [C().warn, C().acc, C().acc2, C().bad, C().warn][k], bad: [2.5, 120, 30, 25, 2][k] })}</div>`).join('') + axis(), { span: 6, tab: 1, full: 1 }),
			sec('레이어에 머문 시간', '30분', `<div style="display:flex;gap:10px;align-items:center">${donut([2, 1, 0].map(l => ({ v: d.layer.filter(x => x === l).length, c: LCOL()[l], label: 'L' + l })), { center: Math.round((d.layer.filter(x => x === 2).length / N) * 100) + '%', sub: 'L2 비율' })}${legend([[C().ok, 'L2', 1], [C().warn, 'L1', 1], [C().bad, 'L0', 1]])}</div>`, { span: 3, tab: 2 }),
			sec('Loss 분포', '30초 구간', hist(d.loss, [0, 0.5, 1, 2, 3, 8], { labels: ['~.5', '~1', '~2', '~3', '3+'], colors: [C().ok, C().acc, C().warn, C().bad, C().bad] }), { span: 3, tab: 1 }),
		],
	};
	// 4) story: 진단 문장 + 이벤트 타임라인 + 대표 그래프 1개
	SETS.story = {
		edge: (d, ctx, i) => {
			const thrN = d.thr.filter(Boolean).length, pk = Math.max(...d.peak), hot = d.peak.indexOf(pk);
			const lines_ = [
				[`<b>CPU 평균 ${f1(last(d.cpu))}%</b>, 같은 30초 안의 1초 최대는 <b>${f1(last(d.peak))}%</b>입니다.`, last(d.peak) > 90 ? 'bad' : 'acc'],
				[thrN ? `최근 30분 동안 <b>throttle ${thrN}번</b>. 가장 높았던 때는 ${ago(hot)} (${Math.round(pk)}%).` : '최근 30분 동안 <b>throttle 없음</b>.', thrN ? 'warn' : 'ok'],
				[`시청자 <b>${last(d.vw)}명</b> · 고화질(L2) ${last(d.l2)}명, 저화질(L0) ${last(d.l0)}명.`, last(d.l0) > 1 ? 'warn' : 'ok'],
			];
			const ev = [];
			d.thr.forEach((v, k) => v && ev.push([k, `CPU throttle ${v}ms`, 'bad']));
			d.vw.forEach((v, k) => k && v > d.vw[k - 1] && ev.push([k, `시청자 입장 → ${v}명`, 'acc']));
			return [
				sec('요약', '', `<div class="k-story">${lines_.map(([t, c]) => `<p style="--sc:var(--${c})">${t}</p>`).join('')}</div>`, { span: 3 }),
				sec('CPU · 평균 / 최대', '', area(d.cpu, { max: 100, unit: '%', over: d.peak, marks: d.thr.map((v, k) => (v ? k : -1)).filter(k => k >= 0), h: 90 }) + axis(), { span: 3, tab: 1 }),
				sec('최근 이벤트', ev.length + '건', `<ul class="k-tl">${ev.sort((a, b) => b[0] - a[0]).slice(0, 7).map(([k, t, c]) => `<li style="--tc:var(--${c})"><time>${ago(k)}</time>${t}</li>`).join('')}</ul>`, { span: 3, tab: 3 }),
				sec('주의할 시청자', '', vlist(ctx, i, 3), { span: 3, tab: 3 }),
			];
		},
		viewer: d => {
			const s = score(d), [g, k] = grade(s);
			const why = [];
			if (last(d.loss) > 1) why.push(`loss ${f1(last(d.loss))}%`);
			if (last(d.rtt) > 80) why.push(`RTT ${Math.round(last(d.rtt))}ms`);
			if (d.freezes.length) why.push(`멈춤 ${d.freezes.length}번`);
			if (last(d.layer) < 2) why.push(`저화질 L${last(d.layer)}`);
			const col = { join: 'acc', down: 'warn', up: 'ok', freeze: 'bad', loss: 'warn' };
			return [
				sec('한 줄 진단', pill(g, k), `<div class="k-story"><p style="--sc:var(--${k})">체감 품질 <b>${s}점 (${g})</b>. ${why.length ? '원인 후보: ' + why.join(', ') + '.' : '특이사항 없음.'}</p><p>입장 ${d.joined * 0.5 | 0}분 전 · ${d.browser} · ${d.net}</p></div>`, { span: 3 }),
				sec('Loss · 멈춤 위치', '', area(d.loss, { c: C().warn, unit: '%', marks: d.freezes, h: 80 }) + axis(), { span: 3, tab: 1 }),
				sec('이 시청자에게 일어난 일', d.events.length + '건', `<ul class="k-tl">${[...d.events].reverse().slice(0, 8).map(e => `<li style="--tc:var(--${col[e.t]})"><time>${ago(e.k)}</time>${e.txt}</li>`).join('')}</ul>`, { span: 3, tab: 3 }),
				sec('레이어', 'L' + last(d.layer), timeline(d.layer, LCOL(), { marks: d.freezes }) + axis(), { span: 3, tab: 2 }),
			];
		},
	};
	// 5) compare: 다른 서버/같은 서버 시청자와 비교 (bullet, box)
	SETS.compare = {
		edge: (d, ctx, i) => {
			const fl = fleet(ctx), fa = k => avg(fl.map(x => last(x[k]))), fp = k => Math.max(...fl.map(x => last(x[k])));
			const row = (t, v, k, max, unit) => `<div style="display:grid;grid-template-columns:76px 1fr 54px;gap:8px;align-items:center;margin:4px 0"><span class="sub" style="font-size:10.5px;font-weight:700">${t}</span>${bullet(v, { max, avg: fa(k), p90: fp(k) })}<b style="font-size:12px;text-align:right">${f1(v)}${unit}</b></div>`;
			const rank = [...fl].sort((a, b) => last(b.cpu) - last(a.cpu)).indexOf(d) + 1;
			return [
				kpis([kpi('CPU 순위', rank + '<small>/ ' + fl.length + '</small>'), kpi('평균 대비 CPU', (last(d.cpu) - fa('cpu') > 0 ? '+' : '') + f1(last(d.cpu) - fa('cpu')) + '<small>%p</small>'), kpi('시청자 비중', Math.round((last(d.vw) / Math.max(1, fl.reduce((s, x) => s + last(x.vw), 0))) * 100) + '<small>%</small>')], 3),
				sec('전체 서버와 비교', '▮ 평균 · 회색 = 최대', row('CPU 평균', last(d.cpu), 'cpu', 100, '%') + row('1초 최대', last(d.peak), 'peak', 100, '%') + row('시청자', last(d.vw), 'vw', Math.max(...fl.map(x => last(x.vw))) * 1.2, '명') + row('평균 loss', last(d.loss), 'loss', 4, '%') + row('평균 RTT', last(d.rtt), 'rtt', 150, ''), { span: 3, tab: 1 }),
				sec('서버별 CPU (30분)', '', lines(fl.map(x => ({ a: x.cpu, c: x.color, w: x === d ? 2.6 : 1.2, o: x === d ? 1 : 0.35 })), { max: 100, unit: '%' }) + legend(fl.map(x => [x.color, x.name])) + axis(), { span: 3, tab: 1 }),
				sec('주의할 시청자', '', vlist(ctx, i, 4), { span: 6, tab: 3 }),
			];
		},
		viewer: (d, ctx, i) => {
			const v = ctx.VIEWERS[i], peers = ctx.VIEWERS.map((p, k) => ({ p, k })).filter(o => o.p.edge === v.edge).map(o => viewerData(o.p, o.k));
			const pct = (k, lowGood = true) => { const me = last(d[k]); const better = peers.filter(p => (lowGood ? last(p[k]) > me : last(p[k]) < me)).length; return Math.round((better / Math.max(1, peers.length - 1)) * 100); };
			const row = (t, k, unit, max) => `<div style="display:grid;grid-template-columns:52px 1fr 52px;gap:8px;align-items:center;margin:3px 0"><span class="sub" style="font-size:10.5px;font-weight:700">${t}</span>${box(peers.map(p => last(p[k])), last(d[k]), { max })}<b style="font-size:12px;text-align:right">${f1(last(d[k]))}${unit}</b></div>`;
			return [
				kpis([kpi('같은 서버 시청자', peers.length + '<small>명</small>'), kpi('loss 기준', '상위 ' + (100 - pct('loss')) + '<small>%</small>'), kpi('RTT 기준', '상위 ' + (100 - pct('rtt')) + '<small>%</small>')], 3),
				sec('같은 서버 시청자 분포 속 위치', '● 이 시청자', row('Loss', 'loss', '%', 5) + row('RTT', 'rtt', '', 180) + row('Jitter', 'jit', '', 60) + row('LATE', 'late', '%', 5), { span: 3, tab: 1 }),
				sec('Loss: 나 vs 서버 평균', '', lines([{ a: peers.length ? d.loss.map((_, k) => avg(peers.map(p => p.loss[k]))) : d.loss, c: C().muted, dash: true }, { a: d.loss, c: C().warn, w: 2.4 }], { unit: '%' }) + legend([[C().warn, '이 시청자'], [C().muted, '서버 평균']]) + axis(), { span: 3, tab: 1 }),
				sec('레이어', 'L' + last(d.layer), timeline(d.layer, LCOL(), { marks: d.freezes }) + axis(), { span: 6, tab: 2 }),
			];
		},
	};
	// 6) radar: 건강도 레이더 + 점수
	SETS.radar = {
		edge: (d, ctx, i) => {
			const fl = fleet(ctx);
			const norm = x => [1 - last(x.cpu) / 100, 1 - last(x.peak) / 100, 1 - Math.min(1, x.thr.filter(Boolean).length / 8), 1 - last(x.loss) / 4, 1 - last(x.rtt) / 150, last(x.l2) / Math.max(1, last(x.vw))];
			const me = norm(d), ref = fleet(ctx).map(norm).reduce((a, b) => a.map((v, k) => v + b[k] / fl.length), Array(6).fill(0));
			const s = Math.round(avg(me) * 100);
			return [
				sec('서버 건강도', '점선 = 전체 평균', `<div style="display:grid;grid-template-columns:1fr auto;align-items:center">${radar(['CPU 여유', '최대 여유', 'throttle', 'loss', 'RTT', '고화질'].map((l, k) => ({ label: l, v: me[k] })), { ref, c: d.color })}<div style="text-align:center">${ring(s, { sub: '건강도' })}</div></div>`, { span: 3, full: 1 }),
				sec('CPU', f1(last(d.cpu)) + '%', area(d.cpu, { max: 100, unit: '%', over: d.peak, h: 60 }) + axis(), { span: 3, tab: 1 }),
				sec('시청자', last(d.vw) + '명', area(d.vw, { step: true, c: C().acc2, h: 50 }) + axis(), { span: 3, tab: 3 }),
				sec('주의할 시청자', '', vlist(ctx, i, 3), { span: 3, tab: 3 }),
			];
		},
		viewer: d => {
			const s = score(d), axes = [['Loss', 1 - last(d.loss) / 5], ['RTT', 1 - last(d.rtt) / 200], ['Jitter', 1 - last(d.jit) / 60], ['fps', last(d.fps) / 30], ['화질', last(d.layer) / 2], ['LATE', 1 - last(d.late) / 5]].map(([label, v]) => ({ label, v }));
			return [
				sec('품질 레이더', '바깥일수록 좋음', `<div style="display:grid;grid-template-columns:1fr auto;align-items:center">${radar(axes)}<div style="text-align:center">${ring(s, { sub: 'QoE' })}<div class="sub" style="margin-top:4px">${d.browser}<br>${d.net}</div></div></div>`, { span: 3, full: 1 }),
				sec('Loss · RTT', '', lines([{ a: d.loss.map(v => v * 30), c: C().warn }, { a: d.rtt, c: C().acc }], { max: 180 }) + legend([[C().warn, 'loss ×30'], [C().acc, 'RTT']]) + axis(), { span: 3, tab: 1 }),
				sec('레이어 · 멈춤', '', timeline(d.layer, LCOL(), { marks: d.freezes }) + axis(), { span: 3, tab: 2 }),
				sec('fps', f1(last(d.fps)), area(d.fps, { c: C().ok, max: 32, h: 50 }) + axis(), { span: 3, tab: 2 }),
			];
		},
	};
	// 7) minimal: 큰 숫자 + 막대 미니 추이 (조용한 화면)
	SETS.minimal = {
		edge: (d, ctx, i) => [
			sec('CPU', '평균 / 1초 최대', `<div style="display:flex;align-items:baseline;gap:14px"><span class="k-big">${f1(last(d.cpu))}<small>%</small></span><span class="k-big" style="font-size:24px;color:var(--${last(d.peak) > 90 ? 'bad' : 'muted'})">${f1(last(d.peak))}<small>%</small></span></div>` + micro(d.cpu, { max: 100 }), { span: 3, tab: 1 }),
			sec('시청자', '', `<span class="k-big">${last(d.vw)}<small>명</small></span>` + micro(d.vw, { c: C().acc2 }), { span: 3, tab: 3 }),
			sec('송신', '', `<span class="k-big" style="font-size:28px">${fBps(last(d.egress))}</span>` + micro(d.egress, { c: C().ok }), { span: 2, tab: 2 }),
			sec('Throttle', '30분', `<span class="k-big" style="font-size:28px;color:var(--${d.thr.some(Boolean) ? 'bad' : 'ok'})">${d.thr.filter(Boolean).length}<small>회</small></span>` + micro(d.thr, { c: C().bad }), { span: 2, tab: 1 }),
			sec('loss', '시청자 평균', `<span class="k-big" style="font-size:28px">${f1(last(d.loss))}<small>%</small></span>` + micro(d.loss, { c: C().warn }), { span: 2, tab: 2 }),
		],
		viewer: d => [
			sec('체감 품질', '', `<span class="k-big" style="color:var(--${grade(score(d))[1]})">${score(d)}<small>/ 100</small></span><div class="sub">${grade(score(d))[0]} · ${d.browser} · ${d.net}</div>`, { span: 2 }),
			sec('Loss', '', `<span class="k-big" style="font-size:30px">${f1(last(d.loss))}<small>%</small></span>` + micro(d.loss, { c: C().warn }), { span: 2, tab: 1 }),
			sec('RTT', '', `<span class="k-big" style="font-size:30px">${Math.round(last(d.rtt))}<small>ms</small></span>` + micro(d.rtt), { span: 2, tab: 1 }),
			sec('화질', '', `<span class="k-big" style="font-size:30px">L${last(d.layer)}</span><span class="sub"> ${fBpsT(last(d.bps))}</span>` + micro(d.layer.map(l => l + 0.2), { c: C().ok, max: 2.2 }), { span: 3, tab: 2 }),
			sec('fps', '', `<span class="k-big" style="font-size:30px">${f1(last(d.fps))}</span>` + micro(d.fps, { c: C().acc2, max: 30 }), { span: 3, tab: 2 }),
		],
	};
	// 8) layers: 레이어(화질) 중심
	SETS.layers = {
		edge: (d, ctx, i) => [
			kpis([kpi('L2 High', last(d.l2) + '<small>명</small>'), kpi('L1 Mid', last(d.l1) + '<small>명</small>'), kpi('L0 Low', last(d.l0) + '<small>명</small>'), kpi('CPU', f1(last(d.cpu)) + '<small>%</small>')]),
			sec('화질별 시청자 (30분)', '쌓은 영역', stack([{ a: d.l2, c: C().ok }, { a: d.l1, c: C().warn }, { a: d.l0, c: C().bad }], { h: 84, unit: '명' }) + legend([[C().ok, 'L2', 1], [C().warn, 'L1', 1], [C().bad, 'L0', 1]]) + axis(), { span: 4, tab: 3 }),
			sec('지금 분포', '', `<div style="display:grid;place-items:center">${donut([{ v: last(d.l2), c: C().ok, label: 'L2' }, { v: last(d.l1), c: C().warn, label: 'L1' }, { v: last(d.l0), c: C().bad, label: 'L0' }], { sub: '시청자' })}</div>`, { span: 2, tab: 3 }),
			sec('CPU가 오르면 화질이 내려가는가', 'CPU vs L0 비율', lines([{ a: d.cpu, c: C().acc }, { a: d.l0.map((v, k) => (v / Math.max(1, d.vw[k])) * 100), c: C().bad, dash: true }], { max: 100, unit: '%' }) + legend([[C().acc, 'CPU %'], [C().bad, 'L0 비율 %']]) + axis(), { span: 6, tab: 1 }),
			sec('송신 비트레이트', fBpsT(last(d.egress)), area(d.egress.map(v => v / 1e6), { c: C().ok, unit: 'M', h: 50 }) + axis(), { span: 6, tab: 2 }),
		],
		viewer: d => [
			kpis([kpi('지금 화질', 'L' + last(d.layer)), kpi('L2 시간', Math.round((d.layer.filter(x => x === 2).length / N) * 100) + '<small>%</small>'), kpi('전환', d.events.filter(e => e.t === 'down' || e.t === 'up').length + '<small>회</small>'), kpi('수신', fBps(last(d.bps)))]),
			sec('화질 단계 (30분)', '', `<div style="display:grid;grid-template-columns:22px 1fr;gap:4px">${[2, 1, 0].map(l => `<span class="sub" style="font-size:10px;font-weight:800">L${l}</span>${timeline(d.layer.map(x => (x === l ? 1 : 0)), ['transparent', LCOL()[l]], { h: 12 })}`).join('')}</div>` + axis(), { span: 6, tab: 2 }),
			sec('수신 비트레이트와 loss', '', lines([{ a: d.bps.map(v => v / 1e6), c: C().ok, step: true }, { a: d.loss.map(v => v / 2), c: C().warn, dash: true }], { max: 3.5 }) + legend([[C().ok, 'Mbps'], [C().warn, 'loss ÷2']]) + axis(), { span: 6, tab: 1 }),
			sec('fps', f1(last(d.fps)), area(d.fps, { c: C().acc2, max: 32, h: 46, marks: d.freezes }) + axis(), { span: 6, tab: 2 }),
		],
	};
	// 9) bands: 분포 띠 (p10~p90) + 중앙값
	SETS.bands = {
		edge: (d, ctx, i) => [
			kpis([kpi('CPU p50', f1(last(d.cpu)) + '<small>%</small>'), kpi('CPU p99(1초)', f1(last(d.peak)) + '<small>%</small>'), kpi('시청자', last(d.vw) + '<small>명</small>')], 3),
			sec('CPU 분포 띠', '띠 = 30초 안의 최소~최대 · 선 = 평균', band(d.cpu.map(v => v * 0.6), d.peak, d.cpu, { max: 100, unit: '%' }) + axis(), { span: 6, tab: 1 }),
			sec('시청자 loss 띠', '띠 = 시청자 p10~p90', band(d.loss.map(v => v * 0.2), d.loss.map(v => v * 2.4 + 0.3), d.loss, { c: C().warn, unit: '%' }) + axis(), { span: 3, tab: 2 }),
			sec('시청자 RTT 띠', '', band(d.rtt.map(v => v * 0.55), d.rtt.map(v => v * 1.9), d.rtt, { c: C().acc2 }) + axis(), { span: 3, tab: 2 }),
			sec('주의할 시청자', '', vlist(ctx, i, 4), { span: 6, tab: 3 }),
		],
		viewer: (d, ctx, i) => {
			const v = ctx.VIEWERS[i], peers = ctx.VIEWERS.map((p, k) => ({ p, k })).filter(o => o.p.edge === v.edge).map(o => viewerData(o.p, o.k));
			const lo = k => d[k].map((_, t) => Math.min(...peers.map(p => p[k][t]))), hi = k => d[k].map((_, t) => Math.max(...peers.map(p => p[k][t]))), md = k => d[k].map((_, t) => avg(peers.map(p => p[k][t])));
			return [
				kpis([kpi('Loss', f1(last(d.loss)) + '<small>%</small>'), kpi('RTT', Math.round(last(d.rtt)) + '<small>ms</small>'), kpi('같은 서버', peers.length + '<small>명</small>')], 3),
				sec('Loss: 같은 서버 시청자 범위 속의 나', '띠 = 최소~최대', band(lo('loss'), hi('loss'), md('loss'), { c: C().muted, me: d.loss, meC: C().warn, unit: '%' }) + legend([[C().warn, '이 시청자'], [C().muted, '서버 평균']]) + axis(), { span: 6, tab: 1 }),
				sec('RTT', '', band(lo('rtt'), hi('rtt'), md('rtt'), { c: C().muted, me: d.rtt, meC: C().acc }) + axis(), { span: 3, tab: 1 }),
				sec('fps', '', band(lo('fps'), hi('fps'), md('fps'), { c: C().muted, me: d.fps, meC: C().ok, max: 32 }) + axis(), { span: 3, tab: 2 }),
			];
		},
	};
	// 10) terminal: 촘촘한 표 + 로그 (운영자용)
	SETS.terminal = {
		edge: (d, ctx, i) => {
			const row = (k, v, a, c) => `<tr><th>${k}</th><td class="n">${v}</td><td style="width:45%">${spark(a, { h: 14, c })}</td></tr>`;
			const ev = []; d.thr.forEach((v, k) => v && ev.push(`<b>${ago(k).padEnd(6)}</b> WARN cpu.throttled ${v}ms peak=${Math.round(d.peak[k])}%`)); d.vw.forEach((v, k) => k && v !== d.vw[k - 1] && ev.push(`<b>${ago(k).padEnd(6)}</b> INFO viewers ${d.vw[k - 1]}→${v}`));
			return [
				sec('metrics', d.pid, `<table class="k-tbl k-mono">${row('cpu.avg', f1(last(d.cpu)) + '%', d.cpu, C().acc)}${row('cpu.peak_1s', f1(last(d.peak)) + '%', d.peak, C().bad)}${row('cpu.throttled', last(d.thr) + 'ms', d.thr, C().bad)}${row('worker.cpu', f1(last(d.worker)) + '%', d.worker, C().acc2)}${row('loop.lag', f1(last(d.lag)) + 'ms', d.lag, C().warn)}${row('viewers', last(d.vw), d.vw, C().acc2)}${row('egress', fBpsT(last(d.egress)), d.egress, C().ok)}${row('viewer.loss', f1(last(d.loss)) + '%', d.loss, C().warn)}${row('viewer.rtt', Math.round(last(d.rtt)) + 'ms', d.rtt, C().acc)}</table>`, { span: 3, full: 1 }),
				sec('events', ev.length + ' lines', `<pre class="k-log k-mono">${ev.reverse().slice(0, 14).join('\n') || 'no events'}</pre>`, { span: 3, tab: 1 }),
				sec('viewers.worst', '', vlist(ctx, i, 4), { span: 6, tab: 3 }),
			];
		},
		viewer: d => {
			const row = (k, v, a, c) => `<tr><th>${k}</th><td class="n">${v}</td><td style="width:45%">${spark(a, { h: 14, c })}</td></tr>`;
			return [
				sec('metrics', 'qoe=' + score(d), `<table class="k-tbl k-mono">${row('loss', f1(last(d.loss)) + '%', d.loss, C().warn)}${row('rtt', Math.round(last(d.rtt)) + 'ms', d.rtt, C().acc)}${row('jitter', Math.round(last(d.jit)) + 'ms', d.jit, C().acc2)}${row('fps', f1(last(d.fps)), d.fps, C().ok)}${row('layer', 'L' + last(d.layer), d.layer, C().ok)}${row('bitrate', fBpsT(last(d.bps)), d.bps, C().ok)}${row('late', f1(last(d.late)) + '%', d.late, C().warn)}</table>`, { span: 3, full: 1 }),
				sec('events', '', `<pre class="k-log k-mono">${[...d.events].reverse().map(e => `<b>${ago(e.k).padEnd(6)}</b> ${e.t.toUpperCase().padEnd(6)} ${e.txt}`).join('\n')}</pre>`, { span: 3, tab: 3 }),
				sec('layer', '', timeline(d.layer, LCOL(), { marks: d.freezes, h: 12 }) + axis(), { span: 6, tab: 2 }),
			];
		},
	};

	// 11) best: 앞의 구성에서 좋은 것만 모은 종합안 (추가 시안 101~)
	SETS.best = {
		edge: (d, ctx, i) => {
			const thrN = d.thr.filter(Boolean).length;
			const lines_ = [
				[`1초 최대 CPU <b>${f1(last(d.peak))}%</b> (평균 ${f1(last(d.cpu))}%). 평균만 보면 놓치는 순간 부하입니다.`, last(d.peak) > 90 ? 'bad' : 'acc'],
				[thrN ? `30분 동안 <b>throttle ${thrN}번</b> → 그때 시청자 화질이 내려갔는지 오른쪽 그래프로 확인.` : '30분 동안 <b>throttle 없음</b>.', thrN ? 'warn' : 'ok'],
			];
			return [
				kpis([kpi('CPU 평균', f1(last(d.cpu)) + '<small>%</small>', { d: d5(d.cpu), du: '%p', spark: spark(d.cpu, { h: 18, max: 100 }) }), kpi('1초 최대', f1(last(d.peak)) + '<small>%</small>', { d: d5(d.peak), du: '%p', spark: spark(d.peak, { h: 18, max: 100, c: C().bad }) }), kpi('Throttle', thrN + '<small>회/30분</small>', { spark: spark(d.thr, { h: 18, c: C().bad }) }), kpi('시청자', last(d.vw) + '<small>명</small>', { d: d5(d.vw), goodUp: true, spark: spark(d.vw, { h: 18, c: C().acc2 }) })]),
				sec('CPU · 평균과 1초 최대', '● throttle', area(d.cpu, { max: 100, unit: '%', over: d.peak, th: 90, thLabel: '90%', marks: d.thr.map((v, k) => (v ? k : -1)).filter(k => k >= 0), h: 84 }) + legend([[C().acc, '평균'], [C().bad, '1초 최대']]) + axis(), { span: 4, tab: 1 }),
				sec('화질별 시청자', 'L2·L1·L0', stack([{ a: d.l2, c: C().ok }, { a: d.l1, c: C().warn }, { a: d.l0, c: C().bad }], { h: 84, unit: '명' }) + axis(), { span: 2, tab: 3 }),
				sec('요약', '', `<div class="k-story">${lines_.map(([t, c]) => `<p style="--sc:var(--${c})">${t}</p>`).join('')}</div>`, { span: 3 }),
				sec('주의할 시청자', '눌러서 보기', vlist(ctx, i, 4), { span: 3, tab: 3 }),
			];
		},
		viewer: (d, ctx, i) => {
			const s = score(d), [g, k] = grade(s);
			const why = [];
			if (last(d.loss) > 1) why.push(`loss ${f1(last(d.loss))}%`);
			if (last(d.rtt) > 80) why.push(`RTT ${Math.round(last(d.rtt))}ms`);
			if (d.freezes.length) why.push(`멈춤 ${d.freezes.length}번`);
			if (last(d.layer) < 2) why.push(`저화질 L${last(d.layer)}`);
			const v = ctx.VIEWERS[i], peers = ctx.VIEWERS.map((p, q) => ({ p, q })).filter(o => o.p.edge === v.edge).map(o => viewerData(o.p, o.q));
			const md = d.loss.map((_, t) => avg(peers.map(p => p.loss[t]))), lo = d.loss.map((_, t) => Math.min(...peers.map(p => p.loss[t]))), hi = d.loss.map((_, t) => Math.max(...peers.map(p => p.loss[t])));
			const col = { join: 'acc', down: 'warn', up: 'ok', freeze: 'bad', loss: 'warn' };
			return [
				sec('체감 품질', pill(g, k), `<div class="k-score">${ring(s, { sub: 'QoE' })}<div class="t"><b>${s}점 · ${g}</b>${why.length ? '원인 후보: ' + why.join(', ') : '특이사항 없음'}<br><span class="sub">${d.browser} · ${d.net} · 입장 ${(d.joined / 2) | 0}분 전</span></div></div>`, { span: 3 }),
				kpis([kpi('Loss', f1(last(d.loss)) + '<small>%</small>', { d: d5(d.loss), du: '%p' }), kpi('RTT', Math.round(last(d.rtt)) + '<small>ms</small>', { d: d5(d.rtt), du: 'ms' }), kpi('fps', f1(last(d.fps)), { d: d5(d.fps), goodUp: true }), kpi('수신', fBps(last(d.bps)))]),
				sec('화질 · 멈춤', 'L' + last(d.layer), timeline(d.layer, LCOL(), { names: ['L0 Low', 'L1 Mid', 'L2 High'], marks: d.freezes }) + legend([[C().ok, 'L2', 1], [C().warn, 'L1', 1], [C().bad, 'L0', 1], [C().bad, '| 멈춤']]) + axis(), { span: 6, tab: 2 }),
				sec('Loss: 같은 서버 시청자 범위 속의 나', '', band(lo, hi, md, { c: C().muted, me: d.loss, meC: C().warn, unit: '%' }) + legend([[C().warn, '이 시청자'], [C().muted, '서버 평균·범위']]) + axis(), { span: 3, tab: 1 }),
				sec('이 시청자에게 일어난 일', d.events.length + '건', `<ul class="k-tl">${[...d.events].reverse().slice(0, 6).map(e => `<li style="--tc:var(--${col[e.t]})"><time>${ago(e.k)}</time>${e.txt}</li>`).join('')}</ul>`, { span: 3, tab: 3 }),
			];
		},
	};

	function otherSections(ctx) { // origin / 송출자: 구성과 상관없이 간단히
		const fl = fleet(ctx), tot = fl.map(x => x.egress).reduce((a, b) => a.map((v, k) => v + b[k]));
		const vw = fl.map(x => x.vw).reduce((a, b) => a.map((v, k) => v + b[k]));
		return [
			kpis([kpi('중계 서버', fl.length + '<small>대</small>'), kpi('전체 시청자', last(vw) + '<small>명</small>'), kpi('전체 송신', fBps(last(tot)))], 3),
			sec('서버별 시청자', '', stack(fl.map(x => ({ a: x.vw, c: x.color })), { h: 76, unit: '명' }) + legend(fl.map(x => [x.color, x.name, 1])) + axis(), { span: 6 }),
			sec('서버별 CPU', '', lines(fl.map(x => ({ a: x.cpu, c: x.color })), { max: 100, unit: '%' }) + axis(), { span: 6 }),
		];
	}

	/* ================= 그리기 ================= */
	let cur = null, tab = 0, oSel = null; // oSel: origin 패널에서 고른 선 (null = 전체 보기, 'all' = 전체 시청자, 또는 node 이름)
	function render() {
		if (!cur) return;
		const { el, ctx } = cur, s = ctx.sel;
		const set = SETS[CFG.content] || SETS.kpi;
		let title, sub, color, secs, kind;
		if (s.kind === 'edge') {
			const e = ctx.EDGES[s.i], d = edgeData(e, s.i, ctx);
			const now = ctx.edgeCount(s.i); if (now) d.vw[N - 1] = now; // 지금 시청자 수는 장면과 맞춤
			const L = window.__LIVE && window.__LIVE[s.i]; if (L) { d.cpu[N - 1] = L.cpu; d.peak[N - 1] = L.peak; } // 장면(랙 애니메이션)과 같은 현재 값
			kind = 'edge'; title = e.name; color = e.color; sub = `중계 서버 · ${e.node || 'node-01'} · ${d.pid} · CPU 한도 ${d.limit}코어`;
			secs = set.edge(d, ctx, s.i);
		} else if (s.kind === 'viewer') {
			const v = ctx.VIEWERS[s.i], d = viewerData(v, s.i), e = ctx.EDGES[v.edge];
			kind = 'viewer'; title = v.name; color = e.color; sub = `시청자 · <span style="color:${e.color}">${e.name}</span> · ${d.browser} · ${d.net}`;
			secs = set.viewer(d, ctx, s.i);
		} else {
			kind = 'other'; title = s.kind === 'origin' ? 'origin-01' : '송출자'; color = C().acc; sub = s.kind === 'origin' ? '원본 서버 · 전체 요약' : 'origin-01로 송출 중';
			secs = set.other ? set.other(ctx) : otherSections(ctx);
		}
		const tabs = TABS[kind];
		let tabsHtml = '';
		if (CFG.layout === 'tabs' && tabs.length > 1) {
			tab = Math.min(tab, tabs.length - 1);
			tabsHtml = `<div class="k-tabs">${tabs.map((t, k) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${t}</button>`).join('')}</div>`;
			// 개요 탭 = 숫자 타일 + 개요 항목 + 다른 탭마다 대표 항목 하나 (나머지는 각 탭에서)
			const firstOf = new Set(tabs.map((_, k) => secs.find(x => (x.tab || 0) === k)).filter(Boolean));
			secs = secs.filter(x => (x.tab || 0) === tab || (tab === 0 && (x.raw || firstOf.has(x))));
			if (!secs.length) secs = [sec(tabs[tab], '', '<div class="sub">이 구성에는 이 탭 항목이 없습니다.</div>')];
		}
		const wrap = x => (x.raw ? x.html.replace('class="k-kpis"', `class="k-kpis" style="--span:${x.span || 6};--kc:${(x.html.match(/k-kpi"/g) || []).length}"`) : `<section class="k-sec${x.full ? ' full' : ''}" style="--span:${x.span || 3}">${x.html}</section>`);
		const st = el.scrollTop;
		el.innerHTML = `<div class="k-headwrap"><div class="k-head"><div><h2><i style="--c:${color}"></i>${title}</h2><div class="sub">${sub}</div></div><div style="display:flex;gap:8px;align-items:center"><span class="k-live">LIVE</span><button class="k-x" data-close>닫기 ✕</button></div></div></div>${tabsHtml}<div class="k-body">${secs.map(wrap).join('')}</div>${CFG.note ? `<div class="k-note">${CFG.note}</div>` : ''}`;
		el.scrollTop = st;
		el.hidden = false;
	}
	// 그래프에 마우스를 올리면 그 시점 값 표시 (data-tip이 있는 그래프만)
	document.addEventListener('mousemove', e => {
		const w = e.target.closest && e.target.closest('.k-cw[data-tip]');
		document.querySelectorAll('.k-cw.tip-on').forEach(x => x !== w && x.classList.remove('tip-on'));
		if (!w) return;
		const t = JSON.parse(w.dataset.tip), rc = w.getBoundingClientRect(), n = t.s[0].a.length;
		const fx = (e.clientX - rc.left) / rc.width, k = t.b ? clamp(Math.floor(fx * n), 0, n - 1) : clamp(Math.round(fx * (n - 1)), 0, n - 1), px = t.b ? ((k + 0.5) / n) * rc.width : (k / (n - 1)) * rc.width;
		const tip = w.querySelector('.k-tip');
		tip.innerHTML = `<b>${ago(k + (N - n))}</b>` + t.s.map(x => `<span><i style="background:${x.c}"></i>${x.n} <b>${typeof x.a[k] === 'string' ? x.a[k] : f1(x.a[k]) + t.u}</b></span>`).join('');
		w.querySelector('.k-tipl').style.left = px + 'px';
		tip.style.left = Math.min(Math.max(px - 60, 0), rc.width - 130) + 'px';
		w.classList.add('tip-on');
	});
	document.addEventListener('click', e => {
		const t = e.target.closest('#detail [data-close],#detail [data-tab],#detail [data-pick],#detail [data-osel]');
		if (!t || !cur) return;
		if (t.dataset.close != null) cur.ctx.select(null);
		else if (t.dataset.tab != null) { tab = +t.dataset.tab; render(); }
		else if (t.dataset.osel != null) { const v = t.dataset.osel || null; oSel = v && oSel === v ? null : v; render(); }
		else { const [k, i] = t.dataset.pick.split(':'); cur.ctx.select({ kind: k, i: +i }); }
	});
	setInterval(() => { tick(); if (cur && cur.ctx.sel && !document.querySelector('#detail:hover')) render(); }, 2000);

	window.__V = {
		detail(el, ctx) {
			const key = ctx.sel.kind + ':' + (ctx.sel.i ?? '');
			if (!cur || cur.key !== key) { tab = 0; oSel = null; }
			cur = { el, ctx, key };
			render();
		},
		clear() { cur = null; },
	};
})();
