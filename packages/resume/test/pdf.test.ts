import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';
import { renderHtml, htmlToPdf, assertPdfReadable } from '../src/index.ts';
import type { TailoredResume } from '../src/index.ts';

const sample: TailoredResume = {
  basics: { name: 'Vineeth Sakhamuru', email: 'v@example.com', location: 'San Jose, CA', links: [] },
  experience: [
    {
      company: 'OSI Digital',
      role: 'Machine Learning Engineer Intern',
      start: '2024-01',
      end: '2024-06',
      bullets: [{ id: 'osi-2', text: 'Deployed RAG systems with Pinecone and FastAPI.', matched: ['rag'] }],
    },
  ],
  education: [{ school: 'Northeastern University', degree: 'MS Computer Science', start: '2025-09', end: '2027-04' }],
  skills: ['Python', 'FastAPI', 'Docker'],
  keywords: ['rag', 'python', 'fastapi'],
};

test('a rendered PDF reads back name + keyword (machine-parseable)', async () => {
  const out = join(tmpdir(), `resume-readable-${Date.now()}.pdf`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await htmlToPdf(page, renderHtml(sample), out);
    const r = await assertPdfReadable(out, { name: 'Vineeth Sakhamuru', keywords: ['fastapi', 'python'] });
    assert.ok(r.ok, `expected readable; extracted: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /Vineeth Sakhamuru/);
    assert.match(r.text, /FastAPI/i);
  } finally {
    await browser.close();
    rmSync(out, { force: true });
  }
});

test('discriminates: a name/keyword that is NOT in the PDF fails', async () => {
  const out = join(tmpdir(), `resume-readable-neg-${Date.now()}.pdf`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await htmlToPdf(page, renderHtml(sample), out);
    // Text extracts fine, but this candidate name never appears -> not readable-as-expected.
    const r = await assertPdfReadable(out, { name: 'Somebody Else', keywords: ['kubernetes'] });
    assert.equal(r.ok, false);
  } finally {
    await browser.close();
    rmSync(out, { force: true });
  }
});

test('fail-closed: a corrupt / image-only file yields no text and ok:false', async () => {
  const bad = join(tmpdir(), `resume-corrupt-${Date.now()}.pdf`);
  writeFileSync(bad, '%PDF-1.4\nnot a real pdf body\n%%EOF');
  try {
    const r = await assertPdfReadable(bad, { name: 'Vineeth Sakhamuru', keywords: ['python'] });
    assert.equal(r.ok, false);
    assert.equal(r.text, '');
  } finally {
    rmSync(bad, { force: true });
  }
});
