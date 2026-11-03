import { chromePage } from '../src/chrome.ts';
const p = await chromePage('bah.wd1');
const FIRE = `function(el){el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();var k={bubbles:true,cancelable:true,view:window,button:0,clientX:r.x+4,clientY:r.y+4};['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(e){el.dispatchEvent(e.indexOf('pointer')===0?new PointerEvent(e,k):new MouseEvent(e,k))})}`;
const ev = (fn: string, arg?: unknown) => p.evaluate(`(function(arg){var fire=${FIRE};${fn}})(${JSON.stringify(arg ?? null)})`);
const step = () => ev(`var m=document.body.innerText.match(/current step \\d+ of \\d+\\n([^\\n]*)/i); return m?m[1]:''`);
const btn = (t: string) => ev(`var b=[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.innerText.trim()===arg})[0]; if(b) fire(b); return !!b`, t);
for (let i = 0; i < 2 && !/Application Questions 2/.test(String(await step())); i++) { await btn('Back'); await p.waitForTimeout(3000); }
console.log('at', await step());

const pick = async (id: string, want: string) => { await ev(`fire(document.getElementById(arg)); return 1`, id); await p.waitForTimeout(700); await ev(`var o=[].slice.call(document.querySelectorAll('[role=listbox] [role=option]')).filter(function(o){return o.getClientRects().length&&o.innerText.trim()===arg})[0]; if(o) fire(o); return 1`, want); await p.waitForTimeout(500); return ev(`return document.getElementById(arg).innerText.trim()`, id); };
console.log(await pick('secondaryQuestionnaire--b44d5f3bfd361018453351386f03241b', 'None'));
console.log(await pick('secondaryQuestionnaire--b44d5f3bfd361018453351ade04a2424', 'Bachelors Degree'));
for (let i = 0; i < 3 && !/Review/.test(String(await step())); i++) { await btn('Save and Continue'); await p.waitForTimeout(3500); }
console.log('at', await step());
