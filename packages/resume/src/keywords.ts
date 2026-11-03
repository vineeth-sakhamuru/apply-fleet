const STOP = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'that', 'this',
  'have', 'from', 'your', 'their', 'has', 'was', 'were', 'been', 'they',
  'who', 'what', 'when', 'where', 'how', 'why', 'all', 'any', 'can', 'may',
  'a', 'an', 'to', 'of', 'in', 'on', 'at', 'as', 'is', 'be', 'or', 'we',
  'work', 'team', 'role', 'job', 'about', 'looking', 'across', 'within',
  'including', 'strong', 'ability', 'experience', 'years', 'plus', 'etc',
]);

/** Tokenize into skill-ish tokens. `.`, `-`, `/` are kept only between
 *  alphanumerics (so `node.js`, `ci/cd`, `c++`, `c#` survive) — trailing
 *  punctuation like "PostgreSQL." does not stick to the token. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9+#]*(?:[.\-/][a-z0-9+#]+)*/g) ?? [];
}

/** JD keywords, most frequent first, stopwords removed. */
export function extractKeywords(jd: string): string[] {
  const freq = new Map<string, number>();
  for (const t of tokens(jd)) {
    if (STOP.has(t) || t.length < 2) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

/**
 * Tech vocabulary used by the no-fabrication verifier: a rephrased bullet may
 * not introduce one of these terms unless the source bullet already evidences
 * it (via its text or tags).
 */
export const SKILL_VOCAB = new Set([
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust', 'c++',
  'c#', 'ruby', 'scala', 'kotlin', 'swift', 'php',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'node', 'node.js', 'express',
  'fastapi', 'django', 'flask', 'spring', 'rails',
  'sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'dynamodb',
  'cassandra', 'elasticsearch', 'kafka', 'rabbitmq', 'spark', 'hadoop',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
  'graphql', 'rest', 'grpc', 'websocket', 'microservices', 'serverless',
  'pytorch', 'tensorflow', 'llm', 'rag', 'nlp', 'ci/cd', 'jenkins', 'github',
]);
