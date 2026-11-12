// 시안 캡처: node _shared/capture.mjs [id,id,...|all]  (python -m http.server 18777 으로 이 폴더를 띄운 상태에서)
// 각 시안을 열고 서버(edge-01)·시청자(viewer-b84c)를 선택해 두 장씩 찍는다 → shots/<id>-edge.png, shots/<id>-viewer.png
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..');
const shots = join(dir, 'shots');
mkdirSync(shots, { recursive: true });
const all = JSON.parse(readFileSync(join(dir, 'variants.json'), 'utf8'));
const pick = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const list = pick ? all.filter(v => pick.includes(v.id)) : all;
const W = +(process.argv[3] || 1600), H = +(process.argv[4] || 900);

const prof = join(tmpdir(), 'msdash-cap-' + Date.now());
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9334', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + prof, `--window-size=${W},${H}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json/list')).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); let errs = [];
ws.addEventListener('message', ev => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails.text);
	if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value ?? a.description).join(' ').split('\n')[0]);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async f => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }); writeFileSync(join(shots, f), Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const report = [];
for (const v of list) {
	errs = [];
	await send('Page.navigate', { url: 'http://127.0.0.1:18777/' + v.file });
	for (let k = 0; k < 40; k++) { await sleep(250); if (await ev('!!document.querySelector("#scene canvas")')) break; }
	await sleep(800);
	await ev('document.querySelector("#add10")?.click()');
	await sleep(5200);
	await ev('window.__select({kind:"edge",i:0})');
	await sleep(1300);
	const okE = await ev('!!document.querySelector("#detail .k-body")');
	await shot(`${v.id}-edge.jpg`);
	await ev('window.__select({kind:"viewer",i:1})');
	await sleep(1300);
	const okV = await ev('!!document.querySelector("#detail .k-body")');
	await shot(`${v.id}-viewer.jpg`);
	const overflow = await ev('(()=>{const d=document.querySelector("#detail");const r=d.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)].join(",")})()');
	report.push({ id: v.id, okE, okV, rect: overflow, errs: [...new Set(errs)] });
	console.log(v.id, okE && okV ? 'ok' : 'NO PANEL', overflow, errs.length ? 'ERR ' + [...new Set(errs)].join(' | ') : '');
}
writeFileSync(join(shots, 'report.json'), JSON.stringify(report, null, 1));
ws.close(); chrome.kill();
process.exit(0);
