// 시안 100개 생성: node design/variants/_shared/gen.mjs
// 바탕 = design/central-overview-3d.html (현재 3D 시안). 선택 패널만 kit.js로 바꾸고 배치·구성·테마를 조합한다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const base = readFileSync(join(here, '..', '..', 'central-overview-3d.html'), 'utf8');

const LAYOUTS = [
	['dock', '오른쪽 서랍', '장면 오른쪽에 세로로 긴 서랍. 3D를 가리지 않으면서 그래프를 위아래로 길게 본다.'],
	['sheet', '아래 시트', '장면 아래에 가로로 넓은 시트. 그래프가 옆으로 나란히 놓여 한눈에 비교된다.'],
	['float', '떠 있는 카드', '장면 가운데 아래에 떠 있는 카드. 선택한 대상 바로 근처에서 보는 느낌.'],
	['wide', '왼쪽 넓은 패널', '장면 왼쪽에 넓은 패널. 큰 그래프 위주.'],
	['focus', '집중 창', '선택하면 장면이 어두워지고 가운데 큰 창이 열린다. 2열 그래프.'],
	['inspector', '사이드바 교체', '선택하면 오른쪽 사이드바 자리를 상세 패널이 차지한다. 장면은 그대로.'],
	['bento', '벤토 타일', '장면 아래에 크기가 다른 타일들이 격자로 깔린다.'],
	['tabs', '탭 서랍', '오른쪽 서랍 + 탭(개요/자원/네트워크/시청자). 한 번에 한 묶음만.'],
	['hud', '떠 있는 HUD 카드', '패널 배경 없이 작은 유리 카드들이 장면 위에 쌓인다.'],
	['split', '화면 분할', '선택하면 장면이 줄어들고 오른쪽에 상세 열이 생긴다 (2열 그래프).'],
];
const CONTENTS = [
	['kpi', 'KPI + 영역 그래프', '숫자 타일(5분 전 대비) 아래에 CPU 평균·1초 최대, 시청자, 송신, loss·RTT 그래프. 시청자는 레이어 타임라인.'],
	['gauge', '게이지 + 스파크라인', '지금 값은 반원 게이지, 추이는 얇은 스파크라인. 시청자는 QoE 링 점수.'],
	['heat', '히트맵 + 분포', '30분을 30초 칸으로 나눈 히트맵 띠 여러 줄, 레이어 도넛, LATE 히스토그램.'],
	['story', '진단 문장 + 타임라인', '“무슨 일이 있었나”를 문장으로 요약하고, 이벤트 타임라인과 대표 그래프 하나.'],
	['compare', '비교 (전체 대비)', '서버는 전체 서버 평균·최대와 bullet 비교, 시청자는 같은 서버 시청자 분포(box) 속 위치.'],
	['radar', '레이더 + 점수', '건강도/품질을 6축 레이더로, 전체 평균을 점선으로 겹침. 링 점수.'],
	['minimal', '미니멀 큰 숫자', '큰 숫자 + 14칸 막대 추이. 장식을 줄인 조용한 화면.'],
	['layers', '화질(레이어) 중심', '화질별 시청자 쌓은 영역, CPU와 저화질 비율의 관계, 시청자별 레이어 단계표.'],
	['bands', '분포 띠', 'CPU는 30초 안 최소~최대 띠, 시청자는 같은 서버 시청자 범위 띠 속의 내 선.'],
	['terminal', '운영자 터미널', '촘촘한 지표 표 + 인라인 스파크 + 이벤트 로그 (모노스페이스).'],
];
const FONT = {
	plex: 'IBM+Plex+Sans+KR:wght@400;600;700',
	noto: 'Noto+Sans+KR:wght@400;600;800',
	grot: 'Space+Grotesk:wght@500;700',
	mono: 'JetBrains+Mono:wght@400;700',
	inter: 'Inter:wght@400;600;800',
};
const THEMES = [
	['navy', '네이비 글래스 (현재)', { sceneBg: 0x050a24, fonts: [], v: {} }],
	['graphite', '그래파이트', { sceneBg: 0x0c0e13, fonts: ['inter', 'noto'], family: "'Inter','Noto Sans KR'", v: { '--glass': 'rgba(22,24,30,.84)', '--glass-2': 'rgba(32,35,43,.9)', '--line': '#ffffff17', '--acc': '#7aa2ff', '--acc2': '#c792ea', '--ok': '#4ade80', '--card': 'rgba(255,255,255,.035)' }, side: 'linear-gradient(180deg,#14161b,#0e1014)' }],
	['frost', '프로스트 라이트', { sceneBg: 0x18203a, fonts: ['plex'], family: "'IBM Plex Sans KR'", light: true, v: { '--glass': 'rgba(248,250,255,.9)', '--glass-2': '#eef2f8', '--line': '#0f172a1c', '--ink': '#0f172a', '--muted': '#5b6478', '--acc': '#2563eb', '--acc2': '#7c3aed', '--ok': '#059669', '--warn': '#d97706', '--bad': '#e11d48', '--card': 'rgba(15,23,42,.045)', '--grid': '#0f172a14', '--axis': '#0f172a33' }, side: '#eef2f7' }],
	['neon', '네온 사이버', { sceneBg: 0x07001a, fonts: ['grot', 'noto'], family: "'Space Grotesk','Noto Sans KR'", v: { '--glass': 'rgba(12,0,30,.8)', '--line': '#ff2bd64d', '--acc': '#00f0ff', '--acc2': '#ff2bd6', '--warn': '#ffe600', '--bad': '#ff3860', '--card': 'rgba(0,240,255,.05)', '--r': '6px' }, extra: '#detail,#detail .k-sec,#detail .k-kpi{border-radius:6px!important}#detail{box-shadow:0 0 0 1px #00f0ff33,0 0 40px #ff2bd622}', side: 'linear-gradient(180deg,#0d0024,#060012)' }],
	['sunset', '선셋', { sceneBg: 0x140812, fonts: ['plex'], family: "'IBM Plex Sans KR'", v: { '--glass': 'rgba(34,12,26,.8)', '--line': '#ff8a5b33', '--acc': '#ff8a5b', '--acc2': '#ffd166', '--ok': '#7cf29c', '--card': 'rgba(255,138,91,.06)' }, side: 'linear-gradient(180deg,#22101c,#140812)' }],
	['terminal', '터미널 그린', { sceneBg: 0x020a06, fonts: ['mono', 'noto'], family: "'JetBrains Mono','Noto Sans KR',monospace", v: { '--glass': 'rgba(2,12,5,.9)', '--ink': '#c8ffd4', '--muted': '#5f9f6e', '--line': '#39ff7a33', '--acc': '#39ff7a', '--acc2': '#b4ff39', '--ok': '#39ff7a', '--card': 'rgba(57,255,122,.04)', '--grid': '#39ff7a1a', '--axis': '#39ff7a40', '--r': '3px' }, extra: '#detail,#detail .k-sec,#detail .k-kpi{border-radius:3px!important}', side: '#020a05' }],
	['aurora', '오로라', { sceneBg: 0x0a0618, fonts: ['inter', 'noto'], family: "'Inter','Noto Sans KR'", v: { '--glass': 'rgba(20,10,44,.72)', '--line': '#a78bfa33', '--acc': '#8b5cf6', '--acc2': '#22d3ee', '--ok': '#34d399', '--card': 'rgba(139,92,246,.07)', '--r': '22px' }, extra: '#detail{background:linear-gradient(160deg,rgba(76,29,149,.55),rgba(8,47,73,.55) 60%,rgba(20,10,44,.7))!important}', side: 'linear-gradient(180deg,#140a2c,#08061a)' }],
	['contrast', '고대비', { sceneBg: 0x000000, fonts: ['noto'], family: "'Noto Sans KR'", v: { '--glass': 'rgba(0,0,0,.94)', '--line': '#ffffff55', '--acc': '#ffd400', '--acc2': '#00e5ff', '--ok': '#00ff85', '--bad': '#ff3b3b', '--muted': '#d0d0d0', '--card': '#111', '--grid': '#ffffff26', '--axis': '#ffffff66', '--r': '8px' }, side: '#000' }],
	['nord', '노르드', { sceneBg: 0x1c2028, fonts: ['inter', 'noto'], family: "'Inter','Noto Sans KR'", v: { '--glass': 'rgba(46,52,64,.9)', '--glass-2': '#3b4252', '--ink': '#eceff4', '--muted': '#a3adbf', '--line': '#ffffff1a', '--acc': '#88c0d0', '--acc2': '#b48ead', '--ok': '#a3be8c', '--warn': '#ebcb8b', '--bad': '#bf616a', '--card': 'rgba(255,255,255,.04)' }, side: '#2e3440' }],
	['ocean', '오션 틸', { sceneBg: 0x031418, fonts: ['plex'], family: "'IBM Plex Sans KR'", v: { '--glass': 'rgba(3,26,34,.8)', '--line': '#2ee6c533', '--acc': '#2ee6c5', '--acc2': '#5ab0ff', '--card': 'rgba(46,230,197,.05)' }, side: 'linear-gradient(180deg,#04202a,#031418)' }],
];

function themeCss([, , t]) {
	const v = Object.entries(t.v).map(([k, val]) => `${k}:${val}`).join(';');
	let s = `:root{${v}}`;
	if (t.family) s += `body{font-family:${t.family},'Malgun Gothic',sans-serif}`;
	if (t.side) s += `.side{background:${t.side}!important}`;
	if (t.light) s += `.side,.side .panel{color:var(--ink)}.side .panel{background:#fff!important;border-color:var(--line)!important}#scene .hud.tl,#scene .legend,#scene .lbl,#scene .mselbar{color:#fff}#detail{color:var(--ink)}#detail .k-x{color:var(--muted)}`;
	if (t.extra) s += t.extra;
	return s;
}

function rep(s, a, b) {
	if (!s.includes(a)) throw new Error('anchor not found: ' + a.slice(0, 60));
	return s.replace(a, b);
}

// node gen.mjs 121  → 그 id 파일만 다시 쓴다 (후보로 이름을 바꾼 파일을 덮어쓰지 않게)
const only = process.argv[2] ? process.argv[2].split(',') : null;
const items = [];
let n = 0;
for (let L = 0; L < LAYOUTS.length; L++) {
	for (let Cn = 0; Cn < CONTENTS.length; Cn++) {
		n++;
		const T = THEMES[(L * 3 + Cn) % THEMES.length];
		const [lk, ln, ld] = LAYOUTS[L], [ck, cn, cd] = CONTENTS[Cn], [tk, tn, tt] = T;
		const id = String(n).padStart(3, '0');
		const file = `${id}-${lk}-${ck}-${tk}.html`;
		const title = `${id} ${ln} · ${cn} · ${tn}`;
		const cfg = { id, layout: lk, content: ck, theme: tk, sceneBg: tt.sceneBg, note: `시안 ${id} · 배치 ${ln} · 구성 ${cn} · 테마 ${tn} · 모든 값은 예시` };
		const fonts = tt.fonts.length ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${tt.fonts.map(f => 'family=' + FONT[f]).join('&')}&display=swap">` : '';
		let h = base;
		h = h.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
		h = rep(h, '</head>', `${fonts}<link rel="stylesheet" href="_shared/kit.css"><style id="theme">${themeCss(T)}</style><script>window.__CFG=${JSON.stringify(cfg)}</script><script src="_shared/kit.js"></script>\n</head>`);
		h = rep(h, '<body>', `<body class="L-${lk} C-${ck} T-${tk}">`);
		h = rep(h, "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){el.hidden=true;return}", "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){document.body.removeAttribute('data-sel');if(window.__V){window.__V.clear();return}el.hidden=true;return}\n  if(window.__V){document.body.setAttribute('data-sel',sel.kind);window.__V.detail(el,{sel,EDGES,VIEWERS,select:s=>select(s),edgeCount,WARN_LATE});return}");
		h = rep(h, 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨', 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨\nwindow.__select=s=>select(s); // 시안 갤러리 캡처용');
		h = rep(h, 'scene.background=new THREE.Color(0x050a24);scene.fog=new THREE.FogExp2(0x050a24,.016);', 'const BG=(window.__CFG&&window.__CFG.sceneBg)??0x050a24;scene.background=new THREE.Color(BG);scene.fog=new THREE.FogExp2(BG,.016);');
		if (!only || only.includes(id)) writeFileSync(join(out, file), h);
		items.push({ id, file, layout: lk, layoutName: ln, layoutDesc: ld, content: ck, contentName: cn, contentDesc: cd, theme: tk, themeName: tn });
	}
}
// 추가 시안: 종합 구성(best)을 배치 10종 × 현재 테마(101~110), 그리고 오른쪽 서랍/화면 분할 × 다른 테마(111~120)
const BEST = ['best', '종합안', '1초 최대·throttle을 포함한 숫자 타일(미니 추이), CPU 평균/최대, 화질 분포, 요약 문장, 주의 시청자. 시청자는 QoE 점수+원인, 화질 타임라인, 같은 서버 대비 loss 띠, 이벤트.'];
const extra = [...LAYOUTS.map((l, k) => [k, 0]), ...THEMES.slice(1).map((t, k) => [k % 2 ? 9 : 0, k + 1]), [7, 2]];
for (const [L, Ti] of extra) {
	n++;
	const [lk, ln, ld] = LAYOUTS[L], [ck, cn, cd] = BEST, T = THEMES[Ti], [tk, tn, tt] = T;
	const id = String(n).padStart(3, '0');
	const file = `${id}-${lk}-${ck}-${tk}.html`;
	const cfg = { id, layout: lk, content: ck, theme: tk, sceneBg: tt.sceneBg, note: `시안 ${id} · 배치 ${ln} · 종합안 · 테마 ${tn} · 모든 값은 예시` };
	const fonts = tt.fonts.length ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${tt.fonts.map(f => 'family=' + FONT[f]).join('&')}&display=swap">` : '';
	let h = base;
	h = h.replace(/<title>[^<]*<\/title>/, `<title>${id} ${ln} · 종합안 · ${tn}</title>`);
	h = rep(h, '</head>', `${fonts}<link rel="stylesheet" href="_shared/kit.css"><style id="theme">${themeCss(T)}</style><script>window.__CFG=${JSON.stringify(cfg)}</script><script src="_shared/kit.js"></script>\n</head>`);
	h = rep(h, '<body>', `<body class="L-${lk} C-${ck} T-${tk}">`);
	h = rep(h, "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){el.hidden=true;return}", "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){document.body.removeAttribute('data-sel');if(window.__V){window.__V.clear();return}el.hidden=true;return}\n  if(window.__V){document.body.setAttribute('data-sel',sel.kind);window.__V.detail(el,{sel,EDGES,VIEWERS,select:s=>select(s),edgeCount,WARN_LATE});return}");
	h = rep(h, 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨', 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨\nwindow.__select=s=>select(s); // 시안 갤러리 캡처용');
	h = rep(h, 'scene.background=new THREE.Color(0x050a24);scene.fog=new THREE.FogExp2(0x050a24,.016);', 'const BG=(window.__CFG&&window.__CFG.sceneBg)??0x050a24;scene.background=new THREE.Color(BG);scene.fog=new THREE.FogExp2(BG,.016);');
	writeFileSync(join(out, file), h);
	items.push({ id, file, layout: lk, layoutName: ln, layoutDesc: ld, content: ck, contentName: cn, contentDesc: cd, theme: tk, themeName: tn, extra: true });
}
// 선정안(121): 배치 = 012(아래 시트), 색 = 002(그래파이트), 구성 = pick (게이지는 CPU 2개, 시청자 수는 추이 그래프, 주의할 시청자·event loop·worker CPU 제외)
{
	n = 121;
	const [lk, ln, ld] = LAYOUTS[1], T = THEMES[1], [tk, tn, tt] = T, ck = 'pick', cn = '선정안', cd = '012 배치 + 002 색. CPU 게이지 2개(이용률, 최대), CPU 30분, 시청자 수 추이, throttle, 송신. 시청자는 loss·RTT·fps·레이어.';
	const id = '121', file = `${id}-${lk}-${ck}-${tk}.html`;
	const cfg = { id, layout: lk, content: ck, theme: tk, sceneBg: tt.sceneBg, note: `시안 ${id} · 배치 ${ln}(012) · 색 ${tn}(002) · 모든 값은 예시` };
	const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${tt.fonts.map(f => 'family=' + FONT[f]).join('&')}&display=swap">`;
	let h = base;
	h = h.replace(/<title>[^<]*<\/title>/, `<title>${id} 선정안 · ${ln} · ${tn}</title>`);
	h = rep(h, '</head>', `${fonts}<link rel="stylesheet" href="_shared/kit.css"><style id="theme">${themeCss(T)}</style><script>window.__CFG=${JSON.stringify(cfg)}</script><script src="_shared/kit.js"></script>\n</head>`);
	h = rep(h, '<body>', `<body class="L-${lk} C-${ck} T-${tk}">`);
	h = rep(h, "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){el.hidden=true;return}", "function renderDetail(){\n  const el=$('#detail');\n  if(!sel){document.body.removeAttribute('data-sel');if(window.__V){window.__V.clear();return}el.hidden=true;return}\n  if(window.__V){document.body.setAttribute('data-sel',sel.kind);window.__V.detail(el,{sel,EDGES,VIEWERS,select:s=>select(s),edgeCount,WARN_LATE});return}");
	h = rep(h, 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨', 'let select=s=>{sel=s;refreshPanels()}; // 3D가 준비되면 교체됨\nwindow.__select=s=>select(s); // 시안 갤러리 캡처용');
	h = rep(h, 'scene.background=new THREE.Color(0x050a24);scene.fog=new THREE.FogExp2(0x050a24,.016);', 'const BG=(window.__CFG&&window.__CFG.sceneBg)??0x050a24;scene.background=new THREE.Color(BG);scene.fog=new THREE.FogExp2(BG,.016);');
	// 사이드바를 node 단위로: 예시 node 2개(edge-01·02 → node-01, edge-03·04 → node-02). 위에서 node를 고르면
	// Node CPU·qdisc drop·중계 서버 칩·Container CPU·시청자 수가 모두 그 node 기준으로 바뀐다.
	h = rep(h, '<h3>node-01</h3><div class="sub">중계 서버 4대 실행 중 · 예시</div>', '<h3 id="node-title">node-01</h3><div class="sub" id="node-sub"></div>');
	h = rep(h, 'const VIEWERS=[', "EDGES.forEach((e,i)=>e.node=i<2?'node-01':'node-02'); // 예시: 서버가 속한 node\nconst VIEWERS=[");
	h = rep(h, 'NODE_TS.cpu[TS_N-1]=41;NODE_TS.drop[TS_N-1]=12})();', `NODE_TS.cpu[TS_N-1]=41;NODE_TS.drop[TS_N-1]=12})();
const NODE_TS_BY={'node-01':NODE_TS,'node-02':(()=>{const t={cpu:[],drop:[]};let c=28;for(let k=0;k<TS_N;k++){c+=(28-c)*.2+(Math.random()-.5)*3;t.cpu.push(Math.min(95,Math.max(5,c)));t.drop.push(Math.random()<.04?Math.random()*1.2:0)}t.drop[TS_N-1]=0;return t})()};
let nodeSel='node-01';
const nodeEdges=n=>EDGES.map((e,i)=>i).filter(i=>EDGES[i].node===n);`);
	h = rep(h, 'const a=NODE_TS[d.key],max=d.max(a)', 'const a=NODE_TS_BY[nodeSel][d.key],max=d.max(a)');
	h = rep(h, "const drop=NODE_TS.drop[TS_N-1],b=$('#node-badge');b.textContent=drop>0?'주의':'정상';b.classList.toggle('warn',drop>0);",
		`const drop=NODE_TS_BY[nodeSel].drop[TS_N-1],b=$('#node-badge');b.textContent=drop>0?'주의':'정상';b.classList.toggle('warn',drop>0);
  $('#node-title').innerHTML=\`<select class="node-pick" id="node-pick" aria-label="표시할 노드">\${Object.keys(NODE_TS_BY).map(n=>\`<option \${n===nodeSel?'selected':''}>\${n}</option>\`).join('')}</select>\`;
  nodeSub();
  $('#node-pick').onchange=e=>{nodeSel=e.target.value;edgeFilter.clear();filterFromSel=false;if(sel&&(sel.kind==='edge'||sel.kind==='viewer')&&EDGES[sel.kind==='edge'?sel.i:VIEWERS[sel.i].edge].node!==nodeSel)select(null);else renderAllTS()};`);
	// node 머리글(서버 수·시청자 수)은 시청자가 도착할 때마다 다시 그리는 서버 그래프 쪽에서도 갱신
	h = rep(h, 'EDGES.forEach((_,i)=>{EDGE_TS[i].vw[TS_N-1]=edgeCount(i)}); // 현재 시청자 수는 실제 목록과 맞춤', "EDGES.forEach((_,i)=>{EDGE_TS[i].vw[TS_N-1]=edgeCount(i)}); // 현재 시청자 수는 실제 목록과 맞춤\n  nodeSub();");
	h = rep(h, 'function renderNodeTS(){', "function nodeSub(){const ne=nodeEdges(nodeSel);$('#node-sub').textContent=`중계 서버 ${ne.length}대 · 시청자 ${ne.reduce((a,i)=>a+edgeCount(i),0)}명 · 노드 ${Object.keys(NODE_TS_BY).length}개`}\nfunction renderNodeTS(){");
	h = rep(h, 'show=EDGES.map((_,i)=>!edgeFilter.size||edgeFilter.has(i));', "show=EDGES.map((e,i)=>e.node===nodeSel&&(!edgeFilter.size||edgeFilter.has(i)));");
	h = rep(h, "$('#edge-chips').innerHTML=EDGES.map((e,i)=>`<button", "$('#edge-chips').innerHTML=EDGES.map((e,i)=>e.node!==nodeSel?'':`<button");
	h = rep(h, 'if(ei!=null){edgeFilter.clear();edgeFilter.add(ei);filterFromSel=true}', 'if(ei!=null){nodeSel=EDGES[ei].node;edgeFilter.clear();edgeFilter.add(ei);filterFromSel=true}');
	h = rep(h, 'NODE_TS.cpu.shift();NODE_TS.drop.shift();', "NODE_TS.cpu.shift();NODE_TS.drop.shift();\n  {const t=NODE_TS_BY['node-02'],c=t.cpu.at(-1);t.cpu.push(Math.min(95,Math.max(5,c+(28-c)*.15+(Math.random()-.5)*4)));t.drop.push(Math.random()<.04?Math.random()*1.2:0);t.cpu.shift();t.drop.shift()}");
	{ // 3D 바닥판을 node마다 따로: 같은 node의 서버들 아래에만 판을 깔고 판마다 이름표
		const a = h.indexOf('  const plat=new THREE.Mesh(RB(2.9'), lb = h.indexOf("label('node-01 · 중계 서버 4대'"), b = h.indexOf('scene);', lb) + 7;
		if (a < 0 || lb < 0) throw new Error('anchor not found: node platform');
		h = h.slice(0, a) + `  const NODE_GROUPS=[...new Set(EDGES.map(e=>e.node))].map(n=>{const zs=EDGES.map((e,i)=>e.node===n?EZ[i]:null).filter(z=>z!=null),lo=Math.min(...zs),hi=Math.max(...zs);
    return {n,cnt:zs.length,z0:lo-(lo===Math.min(...EZ)?1.8:1.35),z1:hi+(hi===Math.max(...EZ)?1.8:1.35)}});
  NODE_GROUPS.forEach((g,j)=>{const len=g.z1-g.z0,cz=(g.z0+g.z1)/2;
    const plat=new THREE.Mesh(RB(2.9,.18,len,.04),new THREE.MeshStandardMaterial({map:tileTex,metalness:.5,roughness:.45,envMapIntensity:.4}));plat.position.set(P.nodeX,.09,cz);plat.receiveShadow=true;scene.add(plat);
    for(const sx of[-1,1]){const st=new THREE.Mesh(new THREE.BoxGeometry(.03,.03,len-.1),new THREE.MeshBasicMaterial({color:0x0075ff}));st.position.set(P.nodeX+sx*1.45,.15,cz);scene.add(st)}
    const platGlow=new THREE.Mesh(new THREE.PlaneGeometry(6,len+3.2),new THREE.MeshBasicMaterial({map:glowTex,color:0x0075ff,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false}));
    platGlow.rotation.x=-Math.PI/2;platGlow.position.set(P.nodeX,.02,cz);scene.add(platGlow);
    label(g.n+' · 중계 서버 '+g.cnt+'대','tag',new THREE.Vector3(P.nodeX,.2,j===0?g.z0-.5:g.z1+.5),scene);
  });` + h.slice(b);
	}
	// 사이드바 Container CPU: 평균 대신 서버별 현재 값(서버 색)
	h = rep(h, "const val=key==='cpu'?(vis.length===1?Math.round(sum)+'<small>%</small>':'평균 '+Math.round(sum/vis.length)+'<small>%</small>')",
		"const val=key==='cpu'?vis.map(i=>`<span style=\"color:${vis.length>1?EDGES[i].color:'inherit'}\">${Math.round(EDGE_TS[i][key][k])}</span>`).join('<small> · </small>')+'<small>%</small>'");
	// CPU 상태·throttle 애니메이션 (pick-cpufx.js)
	h = rep(h, '  const bursts=[],burstGeo', readFileSync(join(here, 'pick-cpufx.js'), 'utf8') + '  const bursts=[],burstGeo');
	// 화질(레이어) 아이콘 (pick-layerfx.js, window.__CFG.lfx가 있는 121c/d/e에서만 동작)
	h = rep(h, '  const bursts=[],burstGeo', readFileSync(join(here, 'pick-layerfx.js'), 'utf8') + '  const bursts=[],burstGeo');
	h = rep(h, '    for(const b of blinkers){', '    cpuFx(t);layerFx(t);\n    for(const b of blinkers){');
	// 121d: '사람' 모양의 ▶/❚❚ 말풍선을 없앤다 (화질은 발밑 링, freeze는 몸 빨간 깜빡임으로 충분). 이름표는 머리 바로 위로
	h = rep(h, "      const disp=new THREE.Mesh(ICON.bubble,iconMat('person',v.edge,layerOf(v),false));disp.position.set(.2,1.2,.02);f.add(disp);", "      const disp=new THREE.Mesh(ICON.bubble,iconMat('person',v.edge,layerOf(v),false));disp.position.set(.2,1.2,.02);f.add(disp);if(window.__CFG&&window.__CFG.noBubble)disp.visible=false;");
	// 121d: 시청자 이름표는 이름만 (화질은 링, LATE 경고는 주황 테두리로 보이므로 'LATE x% · L2' 줄은 뺀다)
	h = rep(h, "label(`${v.name}<small>LATE ${v.late.toFixed(1)}% · ${v.layer.split(' ')[0]}</small>`,", "label(`${v.name}${window.__CFG&&window.__CFG.noBubble?'':`<small>LATE ${v.late.toFixed(1)}% · ${v.layer.split(' ')[0]}</small>`}`,");
	h = rep(h, '  const LABEL_Y={monitor:1.45,play:1.18,person:1.78};', '  const LABEL_Y={monitor:1.45,play:1.18,person:window.__CFG&&window.__CFG.noBubble?1.25:1.78};');
	h = rep(h, '</head>', '<style>.lbl.edge-l.cpu-warn{border-color:#ffb547;box-shadow:0 0 14px #ffb54766}.lbl.edge-l.cpu-bad{border-color:#ff4d6d;animation:cpuBad .6s steps(2) infinite}@keyframes cpuBad{0%{box-shadow:0 0 18px #ff4d6dcc}100%{box-shadow:0 0 4px #ff4d6d33}}.lbl.edge-l.thr b{color:#ff4d6d}.lbl.edge-l small b{font-weight:800}#legend i.thr-i{width:10px;height:10px;border-radius:50%;border:2px solid #ff4d6d;background:none}</style>\n</head>');
	h = rep(h, '</head>', '<style>.node-pick{background:transparent;color:inherit;font:inherit;font-weight:800;border:1px solid var(--line);border-radius:8px;padding:2px 6px}.node-pick option{background:#16181d}</style>\n</head>');
	if (!only || only.includes(id)) writeFileSync(join(out, file), h);
	items.push({ id, file, layout: lk, layoutName: ln, layoutDesc: ld, content: ck, contentName: cn, contentDesc: cd, theme: tk, themeName: tn, extra: true });
	// 121a / 121b: CPU 표시 방식 비교 (a = 바닥 링 + 상단 라이트, b = a + 문 안쪽 불빛). 나머지는 121과 같다
	// 121c / 121d / 121e: 화질(레이어) 아이콘 비교 (c = 쌓인 판, d = 발밑 링, e = 전파 모양). CPU 표시는 b
	for (const [fx, fxName, lfx, sfx] of [['a', '바닥 링 + 상단 라이트'], ['b', '바닥 링 + 상단 라이트 + 문 안쪽 불빛'], ['b', '화질 아이콘: 쌓인 판', 'plates', 'c'], ['b', '화질 아이콘: 발밑 링', 'ring', 'd'], ['b', '화질 아이콘: 전파 모양', 'wifi', 'e']]) {
		const fid = id + (sfx || fx), ffile = `${fid}-${lk}-${ck}-${tk}.html`, what = lfx ? fxName : 'CPU 표시 ' + fxName;
		const fcfg = { ...cfg, id: fid, fx, ...(lfx ? { lfx } : {}), ...(lfx === 'ring' ? { noBubble: true } : {}), note: `시안 ${fid} · ${what} · 모든 값은 예시` };
		const fh = h.replace(`window.__CFG=${JSON.stringify(cfg)}`, `window.__CFG=${JSON.stringify(fcfg)}`).replace(/<title>[^<]*<\/title>/, `<title>${fid} 선정안 · ${what}</title>`);
		if (!only || only.includes(id) || only.includes(fid)) writeFileSync(join(out, ffile), fh);
		items.push({ id: fid, file: ffile, layout: lk, layoutName: ln, layoutDesc: ld, content: ck, contentName: cn, contentDesc: `${cd} ${what}.`, theme: tk, themeName: tn, extra: true });
	}
}
writeFileSync(join(out, 'variants.json'), JSON.stringify(items, null, 1));
console.log('wrote', items.length, 'variants');
