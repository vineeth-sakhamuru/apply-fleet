import { chromePage } from '../src/chrome.ts';
const p = await chromePage('bah.wd1');
const FIRE = `function(el){el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();var k={bubbles:true,cancelable:true,view:window,button:0,clientX:r.x+4,clientY:r.y+4};['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(e){el.dispatchEvent(e.indexOf('pointer')===0?new PointerEvent(e,k):new MouseEvent(e,k))})}`;
const ev = (fn: string, arg?: unknown) => p.evaluate(`(function(arg){var fire=${FIRE};${fn}})(${JSON.stringify(arg ?? null)})`);
const opts = async (id: string) => { await ev(`fire(document.getElementById(arg)); return 1`, id); await p.waitForTimeout(700); const o = await ev(`return [].slice.call(document.querySelectorAll('[role=listbox] [role=option]')).filter(function(o){return o.getClientRects().length}).map(function(o){return o.innerText.trim()})`, id); await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); fire(document.body); return 1`); await p.waitForTimeout(300); return o; };
const pick = async (id: string, want: string) => { await ev(`fire(document.getElementById(arg)); return 1`, id); await p.waitForTimeout(700); await ev(`var o=[].slice.call(document.querySelectorAll('[role=listbox] [role=option]')).filter(function(o){return o.getClientRects().length&&o.innerText.trim()===arg})[0]; if(o) fire(o); return !!o`, want); await p.waitForTimeout(500); return ev(`return document.getElementById(arg).innerText.trim()`, id); };
const P = 'primaryQuestionnaire--065d9d3c238710011a2e';
const mode = process.argv[2];
if (mode === 'list') { for (const s of ['50fa32c50004','51949c180006','522f02420002','522f02420005']) console.log(s, JSON.stringify(await opts(P + (s === '49bee80a0007' ? '49bee80a0007' : s)))); }
else { const pairs = JSON.parse(process.argv[3]); for (const [s, v] of pairs) console.log(s, '=>', await pick(P + s, v)); }
