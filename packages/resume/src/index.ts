export { buildTailoredResume, resumeFileBase, type BuildOpts, type BuildResult } from './build.ts';
export { tailor, type TailorOpts } from './tailor.ts';
export { verify } from './verify.ts';
export { verifyTraceable } from './traceable.ts';
export { assertPdfReadable } from './pdf.ts';
export { renderLatex, compilePdf, pdflatexAvailable } from './latex.ts';
export { renderHtml, htmlToPdf, type PageLike } from './html.ts';
export { loadResume } from './config.ts';
export { extractKeywords, tokens, SKILL_VOCAB } from './keywords.ts';
export type {
  Bullet,
  Entry,
  EducationItem,
  ResumeSource,
  TailoredResume,
  TailoredEntry,
  TailoredBullet,
  Violation,
} from './types.ts';
