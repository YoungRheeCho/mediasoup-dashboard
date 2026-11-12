  /* ===== 121 선정안: CPU 상태·throttle을 서버 랙 애니메이션으로 (gen.mjs가 3D 코드 안에 끼워 넣는다) =====
   * 상태(계속): 이용률 80% 이상 = 경고(주황, 천천히 숨쉬기), 90% 이상 = 위험(빨강, 빠르게 깜빡임) → 상단 라이트·바닥 링·라벨 테두리
   * 사건(순간): throttle = 랙 아래 빨간 파동 + 상단 라이트 번쩍 + 라벨에 throttle 시간
   *             CPU 최대 100%(그 1초 안 0.1초 값이 한도에 닿음) = 랙 위 작은 주황 섬광
   * 예시 값: edge-04(문이 정면으로 보이는 서버)가 40초 주기로 정상 → 경고 → 위험(throttle) → 정상을 오간다. 나머지는 정상 + 가끔 최대 100%.
   * 표현 방식(window.__CFG.fx): 'b'(기본, 선정) = 바닥 링 + 상단 라이트 + 타공 문 안쪽 불빛(구멍 사이로 새어 나옴), 'a' = 바닥 링 + 상단 라이트만, 'c' = 랙 몸체 전체를 물들임(처음 안)
   */
  const FX = (window.__CFG && window.__CFG.fx) || 'b';
  const CPU_WARN = 80, CPU_BAD = 90, DEMO = 3; // DEMO = 예시로 위험 구간을 오가는 서버 (edge-04)
  const LIVE = EDGES.map(e => ({ cpu: e.cpu, peak: e.cpu + 20, thrMs: 0 }));
  window.__LIVE = LIVE;
  const fx = eGroups.map(g => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, .05, 8, 80), new THREE.MeshBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.copy(g.position).setY(.22); scene.add(ring);
    const body = g.userData.body.material; body.emissive = new THREE.Color(0);
    let door = null;
    if (FX === 'b') { // 타공 문(앞면 z=.67)과 안쪽 판(z=.64) 사이에 빛 판을 넣어 구멍 사이로만 보이게 (rack() 기본 크기 기준)
      door = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 2.0), new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      door.position.set(0, 1.2325, .655); g.add(door);
    }
    return { ring, body, door, base: g.userData.edge.material.color.clone(), thrUntil: -1, peakUntil: -1 };
  });
  const COL = { warn: new THREE.Color(0xffb547), bad: new THREE.Color(0xff4d6d), white: new THREE.Color(0xffffff) };
  let liveSec = 0;
  function liveTick() {
    liveSec++;
    const now = clock.elapsedTime, rnd = Math.random;
    LIVE.forEach((L, i) => {
      if (i === DEMO) { // 시나리오 서버 (로드 7초쯤 위험 구간이 보이도록 위상을 맞춤)
        const p = (liveSec + 20) % 40;
        const target = p < 12 ? 55 : p < 24 ? 84 : p < 36 ? 93 : 60;
        L.cpu = Math.min(99, Math.max(3, target + (rnd() - .5) * 5));
        L.peak = p >= 24 && p < 36 ? 100 : Math.min(100, L.cpu + 8 + rnd() * 12);
        L.thrMs = p >= 24 && p < 36 && rnd() < .65 ? Math.round(8 + rnd() * 50) : 0;
      } else {
        L.cpu = Math.min(70, Math.max(3, EDGES[i].cpu + (rnd() - .5) * 8));
        L.peak = rnd() < .05 ? 100 : Math.min(99, L.cpu + 15 + rnd() * 25);
        L.thrMs = 0;
      }
      L.level = L.cpu >= CPU_BAD ? 2 : L.cpu >= CPU_WARN ? 1 : 0;
      const g = eGroups[i], f = fx[i];
      if (L.thrMs > 0) { f.thrUntil = now + 1.1; if (!reduce) burst(g.position.clone().setY(.24), 0xff4d6d, 1.4 + L.thrMs / 40); }
      else if (L.peak >= 100) { f.peakUntil = now + .45; if (!reduce) burst(g.position.clone().setY(2.9), 0xffb547, .55); }
      if (typeof EDGE_TS !== 'undefined') EDGE_TS[i].cpu[EDGE_TS[i].cpu.length - 1] = L.cpu; // 사이드바 현재 값도 맞춤
      const el = labels['edge' + i];
      el.classList.toggle('cpu-warn', L.level === 1); el.classList.toggle('cpu-bad', L.level === 2); el.classList.toggle('thr', L.thrMs > 0);
      el.innerHTML = `<span class="chip"></span>${EDGES[i].name}<small>CPU ${Math.round(L.cpu)}% · 시청자 ${edgeCount(i)}명${L.thrMs > 0 ? ` · <b>throttle ${L.thrMs}ms</b>` : ''}</small>`;
    });
  }
  setInterval(liveTick, 1000);
  setTimeout(liveTick, 300);
  function cpuFx(t) {
    LIVE.forEach((L, i) => {
      const f = fx[i], strip = eGroups[i].userData.edge.material, lv = L.level || 0;
      const thr = t < f.thrUntil, pk = t < f.peakUntil;
      if (thr) strip.color.copy(COL.bad).multiplyScalar(Math.sin(t * 28) > 0 ? 1.6 : .35);           // throttle: 빠른 번쩍임
      else if (pk) strip.color.copy(COL.warn).lerp(COL.white, .5);                                    // 최대 100%: 짧은 섬광
      else if (lv === 2) strip.color.copy(COL.bad).multiplyScalar(.55 + .45 * (Math.sin(t * 7) > 0 ? 1 : 0)); // 위험: 빠른 깜빡임
      else if (lv === 1) strip.color.copy(COL.warn).multiplyScalar(.6 + .4 * Math.sin(t * 2.4));      // 경고: 숨쉬기
      else strip.color.copy(f.base);
      // 랙 몸체도 은은하게 물들임 (다른 랙·라벨에 일부 가려져도 보이도록)
      const glow = thr ? (Math.sin(t * 28) > 0 ? .55 : .15) : lv === 2 ? .12 + .22 * (Math.sin(t * 7) > 0 ? 1 : 0) : lv === 1 ? .08 + .08 * Math.sin(t * 2.4) : pk ? .2 : 0;
      if (FX === 'c') f.body.emissive.copy(thr || lv === 2 ? COL.bad : COL.warn).multiplyScalar(glow);
      if (f.door) { f.door.material.color.copy(thr || lv === 2 ? COL.bad : COL.warn); f.door.material.opacity = Math.min(1, glow * 2.2); }
      f.ring.material.color.copy(lv === 2 || thr ? COL.bad : COL.warn);
      const target = thr ? .95 : lv === 2 ? .45 + .4 * Math.abs(Math.sin(t * 3.5)) : lv === 1 ? .25 + .2 * Math.sin(t * 2.4) : 0;
      f.ring.material.opacity += (target - f.ring.material.opacity) * .2;
    });
  }
  $('#legend').insertAdjacentHTML('beforeend', '<span class="sep"></span><span><i style="--c:#ffb547"></i>CPU 80%↑</span><span><i style="--c:#ff4d6d"></i>CPU 90%↑</span><span><i class="thr-i"></i>throttle</span>');
