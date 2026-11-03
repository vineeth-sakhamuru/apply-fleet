import { chromePage } from '../src/chrome.ts';
const [m, sel, pdf] = process.argv.slice(2);
const page = await chromePage(m);
await page.setInputFiles(sel, pdf);
console.log('uploaded');
