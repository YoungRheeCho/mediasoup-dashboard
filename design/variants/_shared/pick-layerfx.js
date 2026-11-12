  /* ===== 121c/d/e: 시청자가 받는 화질(레이어)을 시청자 옆 아이콘으로 (gen.mjs가 3D 코드 안에 끼워 넣는다) =====
   * 칸 수 = 레이어 + 1 (L2 = 3칸 초록, L1 = 2칸 노랑, L0 = 1칸 빨강). 빈 칸은 흐린 테두리만 남긴다.
   * 레이어가 바뀌면 짧게 움직여 알린다. 카메라가 멀어지면 흐려지다 사라진다.
   * 모양(window.__CFG.lfx): 'plates' = 쌓인 판(A), 'ring' = 발밑 링 3조각(D), 'wifi' = 전파 모양
   * 예시 값: viewer-b84c가 3초마다 L2↔L1을 오가고(화질 오르내림 재현), 나머지는 가끔 한 단계씩 바뀐다.
   */
  const LFX = window.__CFG && window.__CFG.lfx;
  const LQ_COL = [0xff4d6d, 0xffb547, 0x4ade80], LQ_CSS = ['#ff4d6d', '#ffb547', '#4ade80'];
  const LQ_NEAR = 42, LQ_FAR = 58; // 카메라 거리: NEAR까지 선명, FAR부터 숨김
  const lqWorld = new THREE.Vector3();
  const LQ = {
    plates: {
      geo: new THREE.BoxGeometry(.4, .07, .3),
      make() {
        const h = new THREE.Group(); h.position.set(.95, 0, .15);
        const plates = [0, 1, 2].map(k => {
          const fill = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(this.geo), new THREE.LineBasicMaterial({ color: 0xc8d0dc, transparent: true, opacity: .4 }));
          const p = new THREE.Group(); p.add(fill, edge); p.position.y = .12 + k * .17; h.add(p);
          return { p, fill, edge, y0: .12 + k * .17, on: 0 };
        });
        return { h, plates };
      },
      set(o, n, anim) { // n = 채울 판 수 (1~3)
        o.lq.plates.forEach((pl, k) => {
          const on = k < n;
          if (anim && on && !pl.target) pl.p.position.y = pl.y0 + .45; // 새로 채워지는 판은 위에서 내려앉음
          pl.target = on;
        });
      },
      tick(o, t, a) {
        const col = LQ_COL[o.lqN - 1];
        o.lq.plates.forEach(pl => {
          pl.on += ((pl.target ? 1 : 0) - pl.on) * .15;
          pl.p.position.y += (pl.y0 - pl.p.position.y) * .14;
          pl.fill.material.color.setHex(col).multiplyScalar(.6);
          pl.fill.material.opacity = (.06 + .84 * pl.on) * a;
          pl.edge.material.color.setHex(pl.target ? col : 0xc8d0dc);
          pl.edge.material.opacity = (pl.target ? .9 : .35) * a;
        });
        const s = o.lqT > t ? 1 + .18 * Math.sin((o.lqT - t) * 14) : 1; o.lq.h.scale.setScalar(s);
      },
    },
    ring: {
      geo: [0, 1, 2].map(k => new THREE.RingGeometry(.58, .68, 24, 1, Math.PI * (.5 + k * 2 / 3) + .1, Math.PI * 2 / 3 - .2)), // 12시부터 반시계로 3조각
      make() {
        const h = new THREE.Group(); h.rotation.x = -Math.PI / 2; h.position.y = .014;
        const arcs = this.geo.map(g => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })); h.add(m); return m; });
        return { h, arcs };
      },
      set() {},
      tick(o, t, a) {
        const col = LQ_COL[o.lqN - 1], blink = o.lqT > t ? (Math.sin((o.lqT - t) * 22) > 0 ? 1 : .2) : 1;
        o.lq.arcs.forEach((m, k) => {
          const on = k < o.lqN;
          m.material.color.setHex(on ? col : 0xc8d0dc).multiplyScalar(on ? .9 : 1);
          m.material.opacity = (on ? .9 * blink : .14) * a;
        });
        const s = o.lqT > t ? 1 + .15 * (o.lqT - t) : 1; o.lq.h.scale.setScalar(s);
      },
    },
    wifi: {
      cache: new Map(),
      tex(n) {
        let tx = this.cache.get(n); if (tx) return tx;
        tx = canvasTex(128, 112, (g, w, h) => {
          const cx = w / 2, cy = h - 18;
          g.fillStyle = 'rgba(10,12,16,.72)'; rr(g, 4, 4, w - 8, h - 8, 22); g.fill();
          g.lineCap = 'round';
          for (let k = 1; k <= 3; k++) { // 안쪽부터 1·2·3번째 호
            g.beginPath(); g.arc(cx, cy, 20 + k * 22, Math.PI * 1.22, Math.PI * 1.78);
            g.lineWidth = 11; g.strokeStyle = k <= n ? LQ_CSS[n - 1] : 'rgba(200,208,220,.25)'; g.stroke();
          }
          g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fillStyle = LQ_CSS[n - 1]; g.fill(); // 가운데 점은 늘 켜짐, 켜진 호 수 = 칸 수
        });
        this.cache.set(n, tx); return tx;
      },
      make() {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex(3), transparent: true, depthWrite: false, color: new THREE.Color(.85, .85, .85) }));
        s.scale.set(.62, .54, 1); s.position.set(1.0, .45, 0);
        return { h: s, sprite: s };
      },
      set(o, n) { o.lq.sprite.material.map = this.tex(n); o.lq.sprite.material.needsUpdate = true; },
      tick(o, t, a) {
        const blink = o.lqT > t ? (Math.sin((o.lqT - t) * 22) > 0 ? 1 : .15) : 1;
        o.lq.sprite.material.opacity = a * blink;
        const s = o.lqT > t ? 1 + .2 * (o.lqT - t) : 1; o.lq.sprite.scale.set(.62 * s, .54 * s, 1);
      },
    },
  }[LFX];
  // 아이콘 칸 수 = 레이어 + 1. 바뀌면 lqT(움직임 끝나는 시각)를 잡는다
  function layerFx(t) {
    if (!LQ) return;
    VIEWERS.forEach((v, i) => {
      const o = vObjs[i]; if (!o) return;
      if (!o.lq) { o.lq = LQ.make(); o.group.add(o.lq.h); o.lqN = 0; o.lqT = -1; }
      const n = layerOf(v) + 1;
      if (n !== o.lqN) { const first = !o.lqN; o.lqN = n; LQ.set(o, n, !first); if (!first) o.lqT = t + 1.2; }
      o.group.getWorldPosition(lqWorld);
      const d = camera.position.distanceTo(lqWorld), a = Math.max(0, Math.min(1, (LQ_FAR - d) / (LQ_FAR - LQ_NEAR))) * (.35 + .65 * o.act);
      o.lq.h.visible = a > .02;
      if (o.lq.h.visible) LQ.tick(o, t, a);
    });
  }
  if (LQ) {
    window.__LQV = { vObjs, camera }; // 캡처 확인용
    // 예시 값: 레이어 바꾸기 (bitrate도 레이어에 맞춰 다시 계산)
    const setLayer = (v, n) => {
      v.layer = LAYERS[2 - n];
      const d = Object.getOwnPropertyDescriptor(v, 'bitrateBps');
      if (d && 'value' in d) v.bitrateBps = BPS_BY_LAYER['L' + n] * (0.8 + Math.random() * .4); else delete v._b;
      const i = VIEWERS.indexOf(v), el = labels['viewer' + i];
      if (el) { const s = el.querySelector('small'); if (s) s.textContent = `LATE ${v.late.toFixed(1)}% · 화질 ${n + 1}/3`; }
    };
    VIEWERS.forEach((v, i) => setLayer(v, layerOf(v)));
    let lqSec = 0;
    setInterval(() => {
      lqSec++;
      const flap = VIEWERS.find(v => v.name === 'viewer-b84c');
      if (flap && lqSec % 3 === 0) setLayer(flap, layerOf(flap) === 2 ? 1 : 2);
      if (lqSec % 5 === 0) {
        const c = VIEWERS.filter(v => v !== flap && !v.joining); const v = c[Math.floor(Math.random() * c.length)];
        if (v) { const l = layerOf(v); setLayer(v, l === 2 ? 1 : l === 0 ? 1 : Math.random() < .5 ? 0 : 2); }
      }
      if (typeof renderViewers === 'function') renderViewers();
    }, 1000);
    const ic = {
      plates: n => `<svg width="14" height="14" viewBox="0 0 14 14">${[0, 1, 2].map(k => `<rect x="2" y="${10 - k * 4}" width="10" height="2.6" rx=".6" fill="${k < n ? LQ_CSS[n - 1] : 'none'}" stroke="${k < n ? LQ_CSS[n - 1] : '#c8d0dc66'}" stroke-width=".8"/>`).join('')}</svg>`,
      ring: n => `<svg width="14" height="14" viewBox="-7 -7 14 14">${[0, 1, 2].map(k => { const a0 = -Math.PI / 2 - k * 2 * Math.PI / 3 - .2, a1 = a0 - 2 * Math.PI / 3 + .4, r = 5.2; return `<path d="M${(r * Math.cos(a0)).toFixed(2)} ${(r * Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 0 ${(r * Math.cos(a1)).toFixed(2)} ${(r * Math.sin(a1)).toFixed(2)}" fill="none" stroke-width="2" stroke-linecap="round" stroke="${k < n ? LQ_CSS[n - 1] : '#c8d0dc55'}"/>`; }).join('')}</svg>`,
      wifi: n => `<svg width="14" height="14" viewBox="0 0 14 14">${[1, 2, 3].map(k => `<path d="M${7 - 2 * k} ${12 - 1.6 * k} A${2.6 * k} ${2.6 * k} 0 0 1 ${7 + 2 * k} ${12 - 1.6 * k}" fill="none" stroke-width="1.4" stroke-linecap="round" stroke="${k <= n ? LQ_CSS[n - 1] : '#c8d0dc55'}"/>`).join('')}<circle cx="7" cy="12" r="1.3" fill="${LQ_CSS[n - 1]}"/></svg>`,
    }[LFX];
    $('#legend').insertAdjacentHTML('beforeend', `<span class="sep"></span><span>화질</span><span>${ic(3)}높음</span><span>${ic(2)}중간</span><span>${ic(1)}낮음</span>`);
  }
