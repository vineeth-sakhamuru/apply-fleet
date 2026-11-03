import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ResumeSource } from './types.ts';

/** Load the résumé source of truth (base bullets + tags) from YAML. */
export function loadResume(path: string): ResumeSource {
  return parse(readFileSync(path, 'utf8')) as ResumeSource;
}
