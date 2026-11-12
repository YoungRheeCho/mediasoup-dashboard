// 사람 모형 시안: node _shared/gen-person.mjs  → sfu_dashboard_3d_{a,b,c}.html
// 원본 sfu_dashboard_3d.html의 '사람' 모양(FIGS.person)을 이미 만들어진 3D 모델(glTF)로 바꾼다. 나머지는 원본과 같다.
// 모델은 three.js 공식 예제 모델을 _shared/models/에 받아 둔 것 (r160 examples/models/gltf):
//   a = Xbot.glb (마네킹, idle 동작)           — three.js 예제 모델 (Mixamo 캐릭터 기반)
//   b = RobotExpressive.glb (로봇, Idle 동작)   — Tomás Laulhé, CC0 1.0
//   c = Soldier.glb (사람, Idle 동작)            — three.js 예제 모델 (Mixamo 캐릭터 기반)
// 동작: 시청자마다 가만히 서서 숨 쉬는 동작(idle)을 재생하고, freeze면 동작이 멈추고 몸이 빨갛게 깜빡인다.
//       LATE 경고·서버 색은 발밑 링(원본 그대로), 화질은 바깥 3조각 링(원본 그대로).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(dir, 'sfu_dashboard_3d.html'), 'utf8');
const rep = (h, a, b) => { if (!h.includes(a)) throw new Error('anchor not found: ' + a.slice(0, 80)); return h.replace(a, b); };

const p0 = src.indexOf('    person(v,col,warn){'), p1 = src.indexOf('billboard:true}},', p0) + 'billboard:true}},'.length;
if (p0 < 0 || p1 < p0) throw new Error('person() not found');

const VARIANTS = {
	a: { name: '사람: Xbot 마네킹', file: 'Xbot.glb', anim: 'idle', main: 'asdf1:Beta_HighLimbsGeoSG2', height: 1.15, rotY: 0 },
	b: { name: '사람: 로봇 (RobotExpressive, CC0)', file: 'RobotExpressive.glb', anim: 'Idle', main: 'Main', height: 1.0, rotY: 0 },
	c: { name: '사람: Soldier', file: 'Soldier.glb', anim: 'Idle', main: 'VanguardBodyMat', height: 1.15, rotY: Math.PI },
	// d: 평상복 차림 사람(Michelle). 이 모델엔 춤 동작뿐이라, 뼈 이름이 같은(mixamorig) Xbot의 'idle' 동작(회전만)을 가져다 쓴다
	d: { name: '사람: Michelle (평상복)', file: 'Michelle.glb', anim: 'idle', animFrom: 'Xbot.glb', main: 'Ch03_Body', height: 1.15, rotY: 0 },
	// e: 평범한 사람(Ready Player Me 아바타, three.js 예제 모델)이 안락의자(KayKit Furniture Bits, CC0)에 앉아 태블릿을 보는 자세.
	//    모델엔 동작이 없어서 앉은 자세 + 숨쉬기(아주 작게)를 아래 sitClip()이 뼈 방향으로 직접 만든다
	e: { name: '사람: 앉아서 태블릿 보기', file: 'ReadyPlayerMe.glb', anim: 'sit', sit: true, main: 'Wolf3D_Outfit_Top', height: 1.15, rotY: 0, labelY: 1.12 },
};
// f·g·h: e(앉은 사람) + 머리 위 표시. 화질(레이어)·멈춤을 그림으로 보인다
//   f(A) = 작은 비디오 창: 받는 화면이 화질에 따라 선명 / 흐림 / 모자이크, 멈추면 어두워지고 로딩 표시
//   g(B) = 표정: 화질 높음 웃음(초록) / 중간 무표정(노랑) / 낮음 찡그림(빨강), 멈춤은 X 눈(회색)
//   h(C) = 비디오 창 + 모서리 표정
VARIANTS.f = { ...VARIANTS.e, name: '앉은 사람 + 비디오 창 (A)', badge: 'video', labelY: 2.3 };
VARIANTS.g = { ...VARIANTS.e, name: '앉은 사람 + 표정 (B)', badge: 'face', labelY: 1.9 };
VARIANTS.h = { ...VARIANTS.e, name: '앉은 사람 + 비디오 창·표정 (C)', badge: 'both', labelY: 2.3 };
// i: C에서 사람·의자를 빼고 비디오 창(+표정)만 발밑 링 위에 띄운다. freeze 깜빡임·hover 강조는 창에 칠한다
VARIANTS.i = { name: '비디오 창·표정만 (C, 사람 없음)', noPerson: true, badge: 'both', labelY: 1.75, badgeY: .95 };

// 머리 위 표시용 그림 (브라우저에서 canvas로 그려 레이어·멈춤 조합마다 한 번만 만든다)
const BADGE_JS = `  // 머리 위 표시: BADGE_TEX('video'|'face', layer 0~2, frozen) → 캔버스 텍스처 (조합마다 캐시)
  const BADGE_CSS=['#ff4d6d','#ffb547','#4ade80'],BADGE_CACHE=new Map();
  const badgeScene=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d'); // 영상 속 장면: 하늘·해·산·호수·나무
    let gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#2f6fb0');gr.addColorStop(.62,'#9fd0f0');g.fillStyle=gr;g.fillRect(0,0,w,h);
    g.fillStyle='#ffd166';g.beginPath();g.arc(w*.78,h*.24,h*.11,0,7);g.fill();
    g.fillStyle='#3d5a80';g.beginPath();g.moveTo(0,h*.66);g.lineTo(w*.22,h*.3);g.lineTo(w*.45,h*.62);g.lineTo(w*.63,h*.38);g.lineTo(w,h*.68);g.lineTo(w,h);g.lineTo(0,h);g.fill();
    g.fillStyle='#fafafa';g.beginPath();g.moveTo(w*.22,h*.3);g.lineTo(w*.27,h*.37);g.lineTo(w*.17,h*.37);g.fill();
    g.fillStyle='#2a9d8f';g.fillRect(0,h*.66,w,h*.34);g.fillStyle='#4cc9f0';g.fillRect(w*.08,h*.78,w*.5,h*.1);
    g.fillStyle='#6b4226';g.fillRect(w*.82,h*.52,w*.025,h*.2);g.fillStyle='#1b7f4b';g.beginPath();g.arc(w*.832,h*.5,h*.1,0,7);g.fill();
    g.fillStyle='#e76f51';g.fillRect(w*.66,h*.7,w*.08,h*.08);return c};
  const rrect=(g,x,y,w,h,r)=>{g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath()};
  const drawFace=(g,cx,cy,r,layer,fr)=>{ // 동그란 얼굴: 웃음 / 무표정 / 찡그림 / X 눈
    g.fillStyle=fr?'#9aa3b2':BADGE_CSS[layer];g.strokeStyle='#14161c';g.lineWidth=r*.1;g.beginPath();g.arc(cx,cy,r,0,7);g.fill();g.stroke();
    g.fillStyle=g.strokeStyle='#14161c';g.lineCap='round';
    if(fr){g.lineWidth=r*.11;for(const s of[-1,1]){const ex=cx+s*r*.36,ey=cy-r*.2,d=r*.14;g.beginPath();g.moveTo(ex-d,ey-d);g.lineTo(ex+d,ey+d);g.moveTo(ex+d,ey-d);g.lineTo(ex-d,ey+d);g.stroke()}
      g.beginPath();g.arc(cx,cy+r*.38,r*.14,0,7);g.stroke();return}
    for(const s of[-1,1]){g.beginPath();g.ellipse(cx+s*r*.34,cy-r*.2,r*.1,r*.14,0,0,7);g.fill()}
    g.lineWidth=r*.12;g.beginPath();
    if(layer===2)g.arc(cx,cy+r*.05,r*.45,.2*Math.PI,.8*Math.PI);
    else if(layer===1){g.moveTo(cx-r*.34,cy+r*.4);g.lineTo(cx+r*.34,cy+r*.4)}
    else g.arc(cx,cy+r*.78,r*.42,1.2*Math.PI,1.8*Math.PI);
    g.stroke()};
  window.BADGE_TEX=(kind,layer,fr)=>{const key=kind+layer+fr;if(BADGE_CACHE.has(key))return BADGE_CACHE.get(key);
    const c=document.createElement('canvas'),g=c.getContext('2d');
    if(kind==='face'){c.width=c.height=128;drawFace(g,64,64,56,layer,fr)}
    else{const W=c.width=288,H=c.height=192,pad=8,vw=W-pad*2,vh=H-pad*2-30;
      g.fillStyle='rgba(12,14,20,.92)';rrect(g,2,2,W-4,H-4,18);g.fill();g.strokeStyle='rgba(225,232,242,.85)';g.lineWidth=3;g.stroke();
      // 화면: 화질에 따라 선명(그대로) / 흐림(작게 줄였다 부드럽게 키움) / 모자이크(아주 작게 줄였다 그대로 키움)
      const full=badgeScene(vw,vh),div=[14,5,1][layer],sm=document.createElement('canvas');sm.width=Math.max(1,Math.round(vw/div));sm.height=Math.max(1,Math.round(vh/div));
      sm.getContext('2d').drawImage(full,0,0,sm.width,sm.height);
      g.save();rrect(g,pad,pad,vw,vh,10);g.clip();g.imageSmoothingEnabled=layer===1;g.drawImage(div>1?sm:full,pad,pad,vw,vh);
      if(fr){g.fillStyle='rgba(0,0,0,.55)';g.fillRect(pad,pad,vw,vh);g.strokeStyle='#fff';g.lineWidth=7;g.lineCap='round';g.beginPath();g.arc(W/2,pad+vh/2,24,-.5*Math.PI,1.1*Math.PI);g.stroke()} // 멈춤: 어둡게 + 로딩
      g.restore();
      // 화질 표시 (HD / SD / LD)
      g.font='bold 22px system-ui,sans-serif';const tag=['LD','SD','HD'][layer],tw=g.measureText(tag).width+16;
      g.fillStyle=BADGE_CSS[layer];rrect(g,pad+8,pad+8,tw,30,8);g.fill();g.fillStyle='#14161c';g.fillText(tag,pad+16,pad+31);
      // 아래 재생 막대: ▶(멈춤이면 ❚❚) + 진행선
      const by=H-pad-15;g.fillStyle='#e8edf5';
      if(fr){g.fillRect(pad+10,by-9,5,18);g.fillRect(pad+20,by-9,5,18)}else{g.beginPath();g.moveTo(pad+10,by-10);g.lineTo(pad+28,by);g.lineTo(pad+10,by+10);g.fill()}
      g.fillStyle='rgba(232,237,245,.25)';rrect(g,pad+40,by-3,vw-50,6,3);g.fill();g.fillStyle=fr?'#9aa3b2':BADGE_CSS[layer];rrect(g,pad+40,by-3,(vw-50)*.62,6,3);g.fill();
      if(kind==='both')drawFace(g,W-44,H-50,30,layer,fr)} // C: 오른쪽 아래 모서리에 표정
    const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;BADGE_CACHE.set(key,t);return t};
`;

// 앉아서 두 손으로 태블릿을 들고 내려다보는 자세 (모델 기준: 앞 = +z, 왼쪽 = +x, 미터 단위, 서 있는 기본 자세에서 출발)
// 뼈마다 "다음 뼈로 향하는 방향"을 원하는 방향으로 돌리고, 몸통·목은 앞으로 조금 숙인다. 엉덩이는 의자 좌판 높이로 내린다.
// 반환: 동작 JSON(4.8초 숨쉬기 반복) + 그 자세에서의 두 손 가운데(태블릿 자리)와 태블릿이 얼굴을 보도록 하는 회전
const CHAIR = { file: 'kaykit/armchair.gltf', scale: [.62, .85, .58], seat: .5, hipZ: -.02, z: -.1 }; // 안락의자: 좌판 높이 .5(원래 크기), 앞 = +z. 폭·깊이는 사람에 맞게 줄인다
function sitClip(file) {
	const G = readGlb(file), N = G.j.nodes, nm = i => N[i].name.replace(/^mixamorig:/, ''), idx = Object.fromEntries(N.map((n, i) => [nm(i), i]));
	const qv = (q, v) => qmul(qmul(q, [...v, 0]), qinv(q)).slice(0, 3);
	const unit = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
	const fromTo = (a, b) => { a = unit(a); b = unit(b); const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		if (d < -.9999) return [1, 0, 0, 0]; const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; return qnorm([...c, 1 + d]); };
	const rx = deg => { const h = deg * Math.PI / 360; return [Math.sin(h), 0, 0, Math.cos(h)]; };
	// 기본(서 있는) 자세의 월드 위치·회전
	const rest = {}; const R = i => { if (i == null) return { r: [0, 0, 0, 1], p: [0, 0, 0], s: 1 }; if (rest[i]) return rest[i];
		const n = N[i], P = R(G.par[i]), t = (n.translation || [0, 0, 0]).map(x => x * P.s), lp = qv(P.r, t);
		return (rest[i] = { r: qnorm(qmul(P.r, n.rotation || [0, 0, 0, 1])), p: P.p.map((x, k) => x + lp[k]), s: P.s * ((n.scale || [1])[0]) }); };
	N.forEach((_, i) => R(i));
	// 방향 지정 (뼈 → 다음 뼈). 오른쪽은 x를 뒤집는다
	const DIR = { UpLeg: ['Leg', [.13, -.04, 1]], Leg: ['Foot', [.03, -1, .3]], Arm: ['ForeArm', [.22, -1, .5]], ForeArm: ['Hand', [-.6, .38, 1]], Hand: ['HandMiddle1', [-.35, .3, 1]] };
	const LEAN = { Spine: 5, Spine1: 3, Spine2: 2, Neck: 12, Head: 14 }; // 앞으로 숙이는 각도(도)
	const hips = idx.Hips, frames = 49, T = 4.8, times = [], tracks = {};
	let tablet = null;
	for (let f = 0; f < frames; f++) {
		const t = f / (frames - 1) * T, br = Math.sin(t / T * Math.PI * 2); times.push(+t.toFixed(3));
		const W = {}; // 새 자세의 월드 회전·위치
		const visit = i => {
			const p = G.par[i], P = p != null && W[p] ? W[p] : (p != null ? R(p) : { r: [0, 0, 0, 1], p: [0, 0, 0], s: 1 });
			const Pr = p != null ? R(p) : { r: [0, 0, 0, 1] };
			let r = qnorm(qmul(P.r, qmul(qinv(Pr.r), R(i).r))); // 부모를 따라간 회전
			const name = nm(i), side = /^Left/.test(name) ? 1 : /^Right/.test(name) ? -1 : 0, base = name.replace(/^(Left|Right)/, '');
			if (side && DIR[base] && idx[(side > 0 ? 'Left' : 'Right') + DIR[base][0]] != null) {
				const c = idx[(side > 0 ? 'Left' : 'Right') + DIR[base][0]], restDir = R(c).p.map((x, k) => x - R(i).p[k]);
				const now = qv(qmul(r, qinv(R(i).r)), restDir), want = [DIR[base][1][0] * side, DIR[base][1][1], DIR[base][1][2]];
				r = qnorm(qmul(fromTo(now, want), r));
			}
			if (LEAN[name] != null) r = qnorm(qmul(rx(LEAN[name] + (name.startsWith('Spine') ? 1.2 * br : name === 'Head' ? -1.5 * br : 0)), r));
			// 위치: 엉덩이는 좌판 위로, 나머지는 부모 기준
			let pos;
			if (i === hips) pos = [0, CHAIR.seat * CHAIR.scale[1] + .09, CHAIR.hipZ];
			else { const lt = (N[i].translation || [0, 0, 0]).map(x => x * P.s); const d = qv(P.r, lt); pos = P.p.map((x, k) => x + d[k]); }
			W[i] = { r, p: pos, s: P.s * ((N[i].scale || [1])[0]) };
			(N[i].children || []).forEach(visit);
		};
		visit(hips);
		G.j.skins[0].joints.forEach(i => { if (!W[i]) return; const p = G.par[i], Pw = p != null ? (W[p] || R(p)) : { r: [0, 0, 0, 1] };
			const k = nm(i); (tracks[k] ||= { name: N[i].name.replace(/[\[\]\.:\/]/g, '') + '.quaternion', type: 'quaternion', times, values: [] }).values.push(...qnorm(qmul(qinv(Pw.r), W[i].r)).map(x => Math.round(x * 1e4) / 1e4)); });
		if (f === 0) { // 엉덩이 위치(부모 기준) + 태블릿 자리
			const Pp = G.par[hips] != null ? R(G.par[hips]) : { r: [0, 0, 0, 1], p: [0, 0, 0], s: 1 };
			tracks._hp = { name: N[hips].name.replace(/[\[\]\.:\/]/g, '') + '.position', type: 'vector', times: [0], values: qv(qinv(Pp.r), W[hips].p.map((x, k) => (x - Pp.p[k]) / Pp.s)) };
			const L = W[idx.LeftHand].p, Rh = W[idx.RightHand].p, c = L.map((x, k) => (x + Rh[k]) / 2 + [0, .07, .05][k]);
			const eye = W[idx.Head].p.map((x, k) => x + [0, .08, .09][k]);
			tablet = { p: c.map(x => +x.toFixed(4)), q: fromTo([0, 0, 1], eye.map((x, k) => x - c[k])).map(x => +x.toFixed(4)), w: Math.max(.3, Math.abs(L[0] - Rh[0]) + .1) };
		}
	}
	return { clip: { name: 'sit', duration: T, tracks: Object.values(tracks) }, tablet };
}
// 안락의자 glTF를 html에 넣을 수 있게 bin·텍스처를 data: 주소로 바꾼 JSON 문자열
function chairJSON() {
	const base = join(dir, '_shared/models', dirname(CHAIR.file)), j = JSON.parse(readFileSync(join(dir, '_shared/models', CHAIR.file), 'utf8'));
	j.buffers.forEach(b => (b.uri = 'data:application/octet-stream;base64,' + readFileSync(join(base, b.uri)).toString('base64')));
	(j.images || []).forEach(im => (im.uri = 'data:image/png;base64,' + readFileSync(join(base, im.uri)).toString('base64')));
	return JSON.stringify(j);
}

// 다른 모델(src)의 동작 하나를 이 모델(dst) 뼈대에 옮겨(리타깃) THREE.AnimationClip.parse 형식(JSON)으로 만든다. 회전만 옮긴다.
// 두 모델은 뼈 이름은 같지만 기본 자세의 뼈 방향 값이 달라서(Xbot은 전부 0, Michelle은 아님) 값을 그대로 쓰면 자세가 뒤틀린다.
// 그래서 뼈마다 "기본 자세에서 얼마나 돌았는지"를 월드 기준으로 구해 dst 기본 자세에 똑같이 적용한 뒤, 부모 기준 회전으로 되돌린다.
function readGlb(file) {
	const b = readFileSync(join(dir, '_shared/models', file)), jl = b.readUInt32LE(12);
	const j = JSON.parse(b.slice(20, 20 + jl).toString()), bin = b.slice(20 + jl + 8);
	const par = {}; j.nodes.forEach((n, i) => (n.children || []).forEach(c => (par[c] = i)));
	const acc = i => { const a = j.accessors[i], v = j.bufferViews[a.bufferView], n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type] * a.count;
		if (a.componentType !== 5126) throw new Error('accessor type ' + a.componentType);
		const o = (v.byteOffset || 0) + (a.byteOffset || 0); return Array.from({ length: n }, (_, k) => bin.readFloatLE(o + k * 4)); };
	return { j, par, acc };
}
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = a => [-a[0], -a[1], -a[2], a[3]];
const qnorm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
function retargetClip(srcFile, dstFile, name) {
	const S = readGlb(srcFile), D = readGlb(dstFile);
	const an = S.j.animations.find(a => a.name === name); if (!an) throw new Error('no anim ' + name);
	const rot = {}; let times = null; // 뼈 이름 → 프레임별 회전
	for (const c of an.channels) { if (c.target.path !== 'rotation') continue; const s = an.samplers[c.sampler], t = S.acc(s.input), v = S.acc(s.output);
		if (!times) times = t; else if (t.length !== times.length) throw new Error('frame count differs');
		rot[S.j.nodes[c.target.node].name] = Array.from({ length: t.length }, (_, f) => v.slice(f * 4, f * 4 + 4)); }
	const restL = (G, i) => G.j.nodes[i].rotation || [0, 0, 0, 1];
	// 월드 회전 (f = 프레임, 동작 없는 뼈·조상은 기본 자세)
	const world = (G, i, f, cache) => { if (i == null) return [0, 0, 0, 1]; const k = i; if (cache[k]) return cache[k];
		const nm = G.j.nodes[i].name, l = f != null && G === S && rot[nm] ? rot[nm][f] : restL(G, i);
		return (cache[k] = qnorm(qmul(world(G, G.par[i], f, cache), l))); };
	const sIdx = Object.fromEntries(S.j.nodes.map((n, i) => [n.name, i]));
	const bones = D.j.skins[0].joints.filter(i => sIdx[D.j.nodes[i].name] != null && rot[D.j.nodes[i].name]);
	const sRest = {}, dRest = {}; const tracks = bones.map(i => ({ name: D.j.nodes[i].name.replace(/[\[\]\.:\/]/g, '') + '.quaternion', type: 'quaternion', times: times.map(x => Math.round(x * 1e4) / 1e4), values: [] }));
	for (let f = 0; f < times.length; f++) {
		const sAnim = {}, dAnim = {};
		// dst 월드 회전 = (src 동작 월드 · src 기본 월드⁻¹) · dst 기본 월드
		const dWorld = i => { if (i == null) return [0, 0, 0, 1]; if (dAnim[i]) return dAnim[i];
			const nm = D.j.nodes[i].name, si = sIdx[nm];
			if (si == null || !rot[nm]) return (dAnim[i] = qnorm(qmul(dWorld(D.par[i]), restL(D, i))));
			return (dAnim[i] = qnorm(qmul(qmul(world(S, si, f, sAnim), qinv(world(S, si, null, sRest))), world(D, i, null, dRest)))); };
		bones.forEach((i, k) => { const l = qnorm(qmul(qinv(dWorld(D.par[i])), dWorld(i))); tracks[k].values.push(...l.map(x => Math.round(x * 1e4) / 1e4)); });
	}
	return { name, duration: -1, tracks };
}

for (const [k, V] of Object.entries(VARIANTS)) {
	const SIT = V.sit ? sitClip(V.file) : null;
	// 모델을 한 번 불러 두고(실패하면 원래 기본 도형 사람으로), 시청자마다 뼈대째 복제한다
	const loader = V.noPerson ? BADGE_JS + '  window.PERSON_MIX=[]; // {f,v,tint,badgeUpd}: 화면에 있는 시청자 표시\n' : `  // 사람 모형: ${V.file} (three.js 예제 모델). 키를 ${V.height}로 맞추고 시청자마다 복제해 '${V.anim}' 동작을 재생
  const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
  window.SkeletonUtils=await import('three/addons/utils/SkeletonUtils.js'); // init3D 안에서 쓰도록 전역에 둔다
  // 모델 파일을 html 안에 넣어 둔다 (파일을 더블클릭해 file://로 열면 브라우저가 옆 파일 읽기를 막기 때문)
  const PERSON_B64='${readFileSync(join(dir, '_shared/models', V.file)).toString('base64')}';
  const PERSON=window.PERSON=await new GLTFLoader().parseAsync(Uint8Array.from(atob(PERSON_B64),c=>c.charCodeAt(0)).buffer,'').catch(e=>{console.warn('person model',e);return null});
  let PERSON_S=1,PERSON_Y=0;
  if(PERSON){PERSON.scene.updateMatrixWorld(true);const bb=new THREE.Box3().setFromObject(PERSON.scene);PERSON_S=${V.height}/Math.max(1e-6,bb.max.y-bb.min.y);PERSON_Y=-bb.min.y*PERSON_S}
${V.animFrom ? `  window.PERSON_CLIP=THREE.AnimationClip.parse(${JSON.stringify(retargetClip(V.animFrom, V.file, V.anim))}); // ${V.animFrom}의 '${V.anim}' 동작을 이 뼈대에 옮긴 것 (회전만)\n` : ''}${SIT ? `  window.PERSON_CLIP=THREE.AnimationClip.parse(${JSON.stringify(SIT.clip)}); // 앉은 자세 + 숨쉬기 (gen-person.mjs sitClip)
  window.PERSON_TABLET=${JSON.stringify(SIT.tablet)}; // 두 손 사이 태블릿 자리(모델 기준)와 얼굴 쪽을 보는 회전
  // 안락의자: KayKit Furniture Bits (Kay Lousberg, CC0). 좌판 높이에 엉덩이를 맞춰 두었다
  window.PERSON_CHAIR=await new GLTFLoader().parseAsync(${JSON.stringify(chairJSON())},'').then(g=>{const c=g.scene;c.scale.set(${CHAIR.scale});c.traverse(o=>{if(o.isMesh){o.castShadow=true;o.material.color.multiplyScalar(.26);if(o.material.envMapIntensity!=null)o.material.envMapIntensity=.3}});return c}).catch(e=>{console.warn('chair',e);return null});
` : ''}${V.badge ? BADGE_JS : ''}  Object.assign(window,{PERSON_S,PERSON_Y,PERSON_MIX:[]}); // PERSON_MIX = {mixer,f,v}: 화면에 있는 사람 모형의 동작 (freeze면 멈춤)
`;
	const person = `    person(v,col,warn){const f=new THREE.Group();
      const disp=new THREE.Mesh(ICON.bubble,iconMat('person',v.edge,layerOf(v),false));disp.visible=false;f.add(disp); // 재질 교체 자리 (보이지 않음)
      const edge=new THREE.Mesh(new THREE.TorusGeometry(.2,.01,6,40),new THREE.MeshBasicMaterial({color:warn?0xffb547:col,transparent:true,opacity:0}));edge.visible=false;f.add(edge);
      if(!PERSON){const skin=std(0x7f8896,{metalness:.05,roughness:.7});const torso=new THREE.Mesh(ICON.torso,skin);torso.position.y=.36;f.add(torso);const head=new THREE.Mesh(ICON.head,skin);head.position.y=.83;f.add(head);return {f,body:torso,edge,disp,billboard:true}}
      const m=SkeletonUtils.clone(PERSON.scene);m.scale.multiplyScalar(PERSON_S);m.position.y=PERSON_Y;m.rotation.y=${V.rotY};
      // 재질은 시청자마다 복제 (freeze 깜빡임이 이 시청자에게만 보이게). 몸 재질 = '${V.main}'
      const mats=new Map();
      m.traverse(o=>{if(!o.isMesh)return;o.frustumCulled=false;o.castShadow=true;
        const src=o.material;if(!mats.has(src)){const c=src.clone();if(c.envMapIntensity!=null)c.envMapIntensity=.35;if(c.color)c.color.multiplyScalar(.42);if(c.emissive)c.emissive.setHex(0);mats.set(src,c)}o.material=mats.get(src);
      });
      // freeze 깜빡임·hover 강조는 body.material의 색·발광을 바꾸는 식이라, 몸 전체(모든 부위)에 그대로 옮겨 칠한다.
      // body는 진짜 메시가 아니라 색만 가진 대리 객체: 색 = 원래 색에 곱할 배율(기본 흰색), 발광 = 그대로 더함
      const parts=[...mats.values()].map(c=>({c,base:c.color?c.color.clone():null}));
      const body={material:{color:new THREE.Color(1,1,1),emissive:new THREE.Color(0)}};
      const tint=()=>{const M=body.material;parts.forEach(p=>{if(p.base)p.c.color.copy(p.base).multiply(M.color);if(p.c.emissive)p.c.emissive.copy(M.emissive)})};
      f.add(m);${SIT ? `
      // 의자와 태블릿 (모델 안에 넣어 크기·위치가 함께 맞춰진다)
      if(PERSON_CHAIR){const c=PERSON_CHAIR.clone();c.position.z=${CHAIR.z};m.add(c)}
      {const T=PERSON_TABLET,tb=new THREE.Group();tb.position.fromArray(T.p);tb.quaternion.fromArray(T.q);
        const shell=new THREE.Mesh(new THREE.BoxGeometry(T.w,T.w*.68,.012),std(0x1a1d24,{metalness:.4,roughness:.5}));tb.add(shell);
        const scr=new THREE.Mesh(new THREE.PlaneGeometry(T.w*.9,T.w*.6),new THREE.MeshBasicMaterial({color:new THREE.Color(col).lerp(new THREE.Color(0xffffff),.35)}));scr.position.z=.007;tb.add(scr);
        scr.rotation.y=0;m.add(tb)}` : ''}
      const mixer=new THREE.AnimationMixer(m),clip=${V.animFrom || SIT ? 'PERSON_CLIP' : `THREE.AnimationClip.findByName(PERSON.animations,${JSON.stringify(V.anim)})`};
      if(clip){const a=mixer.clipAction(clip);a.play();mixer.update(Math.random()*clip.duration)} // 시청자마다 동작 시점을 다르게
${V.badge ? `      // 머리 위 표시 (스프라이트라 늘 화면을 향한다). key가 바뀔 때만 그림을 바꾼다
      const kind=${JSON.stringify(V.badge === 'face' ? 'face' : V.badge)},bw=kind==='face'?.66:1.32,bh=kind==='face'?.66:.88;
      const badge=new THREE.Sprite(new THREE.SpriteMaterial({map:BADGE_TEX(kind,layerOf(v),false),transparent:true,depthWrite:false,color:new THREE.Color(.55,.55,.55)}));
      badge.scale.set(bw,bh,1);badge.position.y=${V.badge === 'face' ? 1.28 : 1.48};badge.renderOrder=5;f.add(badge);
      const badgeUpd=t=>{const fr=!!v.freezing,l=layerOf(v),k=l+'|'+fr;if(badge.userData.k!==k){badge.userData.k=k;badge.material.map=BADGE_TEX(kind,l,fr);badge.material.needsUpdate=true}
        badge.material.opacity=fr?.65+.35*Math.abs(Math.sin(t*4)):1};
` : ''}      PERSON_MIX.push({mixer,f,v,tint${V.badge ? ',badgeUpd' : ''}});
      return {f,body,edge,disp,billboard:true}},`;
	const personNo = `    person(v,col,warn){const f=new THREE.Group(); // 사람 없이 머리 위 표시(비디오 창·표정)만
      const disp=new THREE.Mesh(ICON.bubble,iconMat('person',v.edge,layerOf(v),false));disp.visible=false;f.add(disp); // 재질 교체 자리 (보이지 않음)
      const edge=new THREE.Mesh(new THREE.TorusGeometry(.2,.01,6,40),new THREE.MeshBasicMaterial({color:warn?0xffb547:col,transparent:true,opacity:0}));edge.visible=false;f.add(edge);
      const kind='both',BASE=new THREE.Color(.62,.62,.62);
      const badge=new THREE.Sprite(new THREE.SpriteMaterial({map:BADGE_TEX(kind,layerOf(v),false),transparent:true,depthWrite:false,color:BASE.clone()}));
      badge.scale.set(1.5,1.0,1);badge.position.y=${V.badgeY};badge.renderOrder=5;f.add(badge);
      // body = 색만 가진 대리 객체: freeze 빨강·hover 강조를 창 색에 옮긴다
      const body={material:{color:new THREE.Color(1,1,1),emissive:new THREE.Color(0)}};
      const tint=()=>{const M=body.material;badge.material.color.copy(BASE).multiply(M.color).add(M.emissive)};
      const badgeUpd=t=>{const fr=!!v.freezing,l=layerOf(v),k=l+'|'+fr;if(badge.userData.k!==k){badge.userData.k=k;badge.material.map=BADGE_TEX(kind,l,fr);badge.material.needsUpdate=true}};
      PERSON_MIX.push({mixer:null,f,v,tint,badgeUpd});
      return {f,body,edge,disp,billboard:true}},`;
	let h = src.slice(0, p0) + (V.noPerson ? personNo : person) + src.slice(p1);
	h = h.replace(/<title>[^<]*<\/title>/, `<title>sfu_dashboard_3d_${k} · ${V.name}</title>`);
	h = rep(h, "  const {RoomEnvironment}=await import('three/addons/environments/RoomEnvironment.js');\n", "  const {RoomEnvironment}=await import('three/addons/environments/RoomEnvironment.js');\n" + loader); // await가 되는 곳(모듈 import 바로 뒤)에서 미리 불러 둔다
	h = rep(h, 'person:window.__CFG&&window.__CFG.noBubble?1.25:1.78}', `person:${(V.labelY ?? V.height + .3).toFixed(2)}}`);
	// 매 프레임 동작 갱신 (빠진 모형은 목록에서 지우고, freeze 중이면 멈춤)
	h = rep(h, '    cpuFx(t);layerFx(t);', '    cpuFx(t);layerFx(t);\n    for(let k=PERSON_MIX.length-1;k>=0;k--){const x=PERSON_MIX[k];if(!x.f.parent){PERSON_MIX.splice(k,1);continue}x.tint();if(x.badgeUpd)x.badgeUpd(t);if(x.mixer&&!reduce&&!x.v.freezing)x.mixer.update(dt)}');
	// 열면 바로 사람 모양 (위 버튼으로 다른 모양으로 바꿀 수 있다)
	h = rep(h, "VSTYLES.some(x=>x[0]===s)?s:null}catch(e){return null}})()||'monitor';", "VSTYLES.some(x=>x[0]===s)?s:null}catch(e){return null}})()||'monitor';viewerStyle='person';");
	writeFileSync(join(dir, `sfu_dashboard_3d_${k}.html`), h);
	console.log('wrote', `sfu_dashboard_3d_${k}.html`);
}
