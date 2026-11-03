import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'patchright';
import { renderHtml, htmlToPdf } from '../src/index.ts';
import type { TailoredResume } from '../src/index.ts';

const sample: TailoredResume = {
  basics: {
    name: 'Vineeth Sakhamuru',
    email: 'you@example.com',
    phone: '000-000-0000',
    location: 'San Jose, CA',
    links: ['github.com/vineeth-sakhamuru'],
  },
  experience: [
    {
      company: 'OSI Digital',
      role: 'Machine Learning Engineer Intern',
      start: '2024-01',
      end: '2024-06',
      bullets: [{ id: 'osi-2', text: 'Deployed RAG systems with Pinecone & ChromaDB.', matched: ['rag'] }],
    },
  ],
  education: [
    { school: 'Northeastern University', degree: 'MS Computer Science', start: '2025-09', end: '2027-04' },
  ],
  skills: ['Python', 'FastAPI', 'Docker & Kubernetes'],
  keywords: ['rag', 'python'],
};

test('renderHtml carries real content and escapes HTML-unsafe chars', () => {
  const html = renderHtml(sample);
  assert.match(html, /Vineeth Sakhamuru/);
  assert.match(html, /Deployed RAG systems/);
  // "Docker & Kubernetes" must be escaped, never a raw ampersand-tag.
  assert.match(html, /Docker &amp; Kubernetes/);
});

test('htmlToPdf prints a genuine PDF via Chromium (no LaTeX needed)', async () => {
  const out = join(tmpdir(), `resume-smoke-${Date.now()}.pdf`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await htmlToPdf(page, renderHtml(sample), out);
    const head = readFileSync(out).subarray(0, 5).toString('latin1');
    assert.equal(head, '%PDF-', `expected a PDF, got header ${JSON.stringify(head)}`);
  } finally {
    await browser.close();
    try {
      rmSync(out);
    } catch {
      /* best-effort cleanup */
    }
  }
});
