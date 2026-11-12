// 갤러리 페이지 생성: node _shared/index.mjs  → variants/index.html
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const items = JSON.parse(readFileSync(join(dir, 'variants.json'), 'utf8'));
const picks = existsSync(join(dir, 'picks.json')) ? JSON.parse(readFileSync(join(dir, 'picks.json'), 'utf8')) : [];

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>선택 패널 시안 갤러리</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;600;700&display=swap">
<style>
:root{--bg:#070a18;--card:#0f1430;--line:#ffffff17;--ink:#eef2ff;--muted:#9aa4c2;--acc:#2cd9ff;--acc2:#a78bfa}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f4f6fb;--card:#fff;--line:#0f172a1a;--ink:#0f172a;--muted:#5b6478;--acc:#2563eb;--acc2:#7c3aed}}
:root[data-theme="light"]{--bg:#f4f6fb;--card:#fff;--line:#0f172a1a;--ink:#0f172a;--muted:#5b6478;--acc:#2563eb;--acc2:#7c3aed}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 'IBM Plex Sans KR','Malgun Gothic',sans-serif}
header{padding:28px 24px 8px;max-width:1500px;margin:0 auto}
h1{margin:0;font-size:24px;letter-spacing:-.01em}
.lead{color:var(--muted);max-width:900px;margin:6px 0 0}
.bar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar-in{max-width:1500px;margin:0 auto;padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
.grp{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.grp>span{font-size:11px;font-weight:700;color:var(--muted);margin-right:4px}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:3px 10px;font:600 12px/1.4 inherit;cursor:pointer}
.chip.on{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 18%,var(--card))}
.count{margin-left:auto;font-size:12px;color:var(--muted)}
main{max-width:1500px;margin:0 auto;padding:16px 24px 60px}
h2{font-size:15px;margin:22px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card:hover{border-color:var(--acc)}
.thumb{position:relative;aspect-ratio:16/9;background:#050816;display:block;overflow:hidden}
.thumb img{position:relative;z-index:1;width:100%;height:100%;object-fit:cover;display:block}
.thumb .badge,.thumb .pick{z-index:2}
.thumb .noimg{position:absolute;inset:0;display:grid;place-items:center;color:#9aa4c2;font-size:12px}
.badge{position:absolute;left:8px;top:8px;background:#000a;color:#fff;border-radius:7px;padding:1px 7px;font-size:11px;font-weight:700}
.pick{position:absolute;right:8px;top:8px;background:#ffb547;color:#1b1200;border-radius:7px;padding:1px 7px;font-size:11px;font-weight:800}
.body{padding:10px 12px 12px;display:grid;gap:6px}
.body b{font-size:13.5px}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tags span{font-size:10.5px;font-weight:700;border-radius:6px;padding:1px 6px;background:color-mix(in srgb,var(--acc) 12%,transparent);color:var(--ink)}
.tags span.c{background:color-mix(in srgb,var(--acc2) 15%,transparent)}
.tags span.t{background:color-mix(in srgb,var(--muted) 15%,transparent)}
.desc{font-size:12px;color:var(--muted)}
.why{font-size:12px;border-left:3px solid #ffb547;padding-left:8px}
.acts{display:flex;gap:6px;margin-top:2px}
.acts a,.acts button{flex:1;text-align:center;border:1px solid var(--line);border-radius:9px;padding:5px 8px;font:700 12px inherit;color:var(--ink);background:transparent;text-decoration:none;cursor:pointer}
.acts a.open{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 16%,transparent)}
.empty{color:var(--muted);padding:30px 0}
@media(max-width:640px){header,.bar-in,main{padding-left:16px;padding-right:16px}.grid{grid-template-columns:1fr}}
</style></head><body>
<header>
  <h1>선택 패널 시안 ${items.length}개</h1>
  <p class="lead">현재 3D 화면(design/central-overview-3d.html)에서 <b>서버나 시청자를 눌렀을 때 나오는 상세 패널</b>을 그래프 중심으로 바꾼 시안입니다. 배치 10종 × 그래프 구성 10종을 조합하고 테마 10종을 섞었습니다. 썸네일 위 버튼으로 서버 선택 화면과 시청자 선택 화면을 바꿔 볼 수 있습니다. 모든 값은 예시이고, 시안을 열면 3D 장면에서 직접 서버·시청자를 눌러 볼 수 있습니다 (인터넷 필요: three.js CDN).</p>
</header>
<div class="bar"><div class="bar-in">
  <div class="grp" id="f-view"><span>썸네일</span><button class="chip on" data-v="edge">서버 선택</button><button class="chip" data-v="viewer">시청자 선택</button></div>
  <div class="grp" id="f-layout"><span>배치</span></div>
  <div class="grp" id="f-content"><span>구성</span></div>
  <div class="grp" id="f-theme"><span>테마</span></div>
  <span class="count" id="count"></span>
</div></div>
<main>
  <section id="picks-wrap"><h2>먼저 볼 만한 시안</h2><div class="grid" id="picks"></div></section>
  <h2>전체</h2>
  <div class="grid" id="grid"></div>
</main>
<script>
const ITEMS=${JSON.stringify(items)};
const PICKS=${JSON.stringify(picks)};
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const state={view:'edge',layout:null,content:null,theme:null};
const uniq=(k,n)=>[...new Map(ITEMS.map(i=>[i[k],i[n]])).entries()];
function chips(id,k,n){const el=document.getElementById(id);el.insertAdjacentHTML('beforeend',[['','전체'],...uniq(k,n)].map(([v,t])=>'<button class="chip '+(v===''?'on':'')+'" data-v="'+v+'">'+esc(t)+'</button>').join(''));
  el.onclick=e=>{const b=e.target.closest('.chip');if(!b)return;state[k]=b.dataset.v||null;el.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on',c===b));render()}}
chips('f-layout','layout','layoutName');chips('f-content','content','contentName');chips('f-theme','theme','themeName');
document.getElementById('f-view').onclick=e=>{const b=e.target.closest('.chip');if(!b)return;state.view=b.dataset.v;document.querySelectorAll('#f-view .chip').forEach(c=>c.classList.toggle('on',c===b));render()};
function card(i,why){return '<article class="card"><a class="thumb" href="'+i.file+'" target="_blank" rel="noopener"><img loading="lazy" src="shots/'+i.id+'-'+state.view+'.jpg" alt="시안 '+i.id+' 미리보기" onerror="this.remove()"><span class="noimg">미리보기 없음</span><span class="badge">'+i.id+'</span>'+(why?'<span class="pick">추천</span>':'')+'</a>'
  +'<div class="body"><b>'+esc(i.layoutName)+' · '+esc(i.contentName)+'</b><div class="tags"><span>'+esc(i.layoutName)+'</span><span class="c">'+esc(i.contentName)+'</span><span class="t">'+esc(i.themeName)+'</span></div>'
  +(why?'<div class="why">'+esc(why)+'</div>':'')+'<div class="desc">'+esc(i.layoutDesc)+' '+esc(i.contentDesc)+'</div>'
  +'<div class="acts"><a class="open" href="'+i.file+'" target="_blank" rel="noopener">열기 ↗</a><a href="shots/'+i.id+'-edge.jpg" target="_blank" rel="noopener">서버 캡처</a><a href="shots/'+i.id+'-viewer.jpg" target="_blank" rel="noopener">시청자 캡처</a></div></div></article>'}
function render(){
  const f=ITEMS.filter(i=>(!state.layout||i.layout===state.layout)&&(!state.content||i.content===state.content)&&(!state.theme||i.theme===state.theme));
  document.getElementById('grid').innerHTML=f.map(i=>card(i)).join('')||'<div class="empty">조건에 맞는 시안이 없습니다.</div>';
  document.getElementById('count').textContent=f.length+' / '+ITEMS.length+'개';
  const pw=document.getElementById('picks-wrap');pw.hidden=!PICKS.length;
  document.getElementById('picks').innerHTML=PICKS.map(p=>{const i=ITEMS.find(x=>x.id===p.id);return i?card(i,p.why):''}).join('');
}
render();
</script>
</body></html>`;
writeFileSync(join(dir, 'index.html'), html);
console.log('index.html', items.length, 'items', picks.length, 'picks');
