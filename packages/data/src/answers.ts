import type { FieldSource } from '@apply-fleet/shared';
import type { Db } from './db.ts';

/** Collapse a question label to a stable cache key. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');
}

export interface CachedAnswer {
  questionNorm: string;
  question: string;
  answer: string;
  source: FieldSource;
  updatedAt: string;
}

interface AnswerRow {
  question_norm: string;
  question: string;
  answer: string;
  source: string;
  updated_at: string;
}

export async function getAnswer(
  db: Db,
  question: string,
): Promise<CachedAnswer | undefined> {
  const row = await db.get<AnswerRow>(
    'SELECT * FROM answers WHERE question_norm = ?',
    [normalizeQuestion(question)],
  );
  return row
    ? {
        questionNorm: row.question_norm,
        question: row.question,
        answer: row.answer,
        source: row.source as FieldSource,
        updatedAt: row.updated_at,
      }
    : undefined;
}
