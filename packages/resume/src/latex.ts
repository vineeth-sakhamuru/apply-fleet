import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TailoredResume } from './types.ts';

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Render a tailored résumé to LaTeX (trimmed Jake's-template layout). */
export function renderLatex(r: TailoredResume): string {
  const links = (r.basics.links ?? []).map(esc).join(' $|$ ');
  const experience = r.experience
    .map(
      (e) => `\\resumeSubheading{${esc(e.role)}}{${esc(e.start)} -- ${esc(e.end)}}{${esc(e.company)}}{}
\\resumeItemListStart
${e.bullets.map((b) => `  \\resumeItem{${esc(b.text)}}`).join('\n')}
\\resumeItemListEnd`,
    )
    .join('\n');
  const education = r.education
    .map(
      (ed) =>
        `\\resumeSubheading{${esc(ed.school)}}{${esc(ed.start)} -- ${esc(ed.end)}}{${esc(ed.degree)}}{${esc(ed.detail ?? '')}}`,
    )
    .join('\n');

  return `\\documentclass[letterpaper,11pt]{article}
% Jake's resume template (trimmed for the pipeline)
\\usepackage[margin=0.6in]{geometry}
\\newcommand{\\resumeItem}[1]{\\item\\small{#1}}
\\newcommand{\\resumeSubheading}[4]{\\item\\textbf{#1}\\hfill #2\\\\\\textit{#3}\\hfill\\textit{#4}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}}
\\begin{document}
\\begin{center}{\\Large\\textbf{${esc(r.basics.name)}}}\\\\
${esc(r.basics.email)}${r.basics.phone ? ` $|$ ${esc(r.basics.phone)}` : ''}${links ? ` $|$ ${links}` : ''}
\\end{center}
\\section*{Experience}\\begin{itemize}
${experience}
\\end{itemize}
\\section*{Education}\\begin{itemize}
${education}
\\end{itemize}
\\section*{Skills}${esc(r.skills.join(', '))}
\\end{document}`;
}

export function pdflatexAvailable(): boolean {
  try {
    execFileSync('pdflatex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the .tex and compile to PDF when pdflatex is installed. When it isn't,
 * emit the .tex and report `compiled: false` (gated on the LaTeX toolchain).
 */
export function compilePdf(
  tex: string,
  outBase: string,
): { pdf?: string; tex: string; compiled: boolean } {
  const texPath = `${outBase}.tex`;
  writeFileSync(texPath, tex);
  if (!pdflatexAvailable()) return { tex: texPath, compiled: false };
  execFileSync(
    'pdflatex',
    ['-interaction=nonstopmode', '-output-directory', dirname(outBase), texPath],
    { stdio: 'ignore' },
  );
  return { pdf: `${outBase}.pdf`, tex: texPath, compiled: true };
}
