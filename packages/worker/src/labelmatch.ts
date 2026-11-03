/**
 * Semantic label matcher — maps a form-field label the regex rules missed to a
 * known answer key by meaning, using local MiniLM sentence embeddings. This is
 * an additive resolver tier: it never guesses a VALUE, only which known key a
 * label is asking for; the grounded value still comes from the deterministic
 * layer.
 *
 * OFFLINE-SAFE: if the model can't load (no cache, no network), every call
 * returns null so the caller falls to HITL — it never throws. The model loads
 * once (module singleton) and stays warm.
 */

/** Cosine floor to accept a match. Below this the label is too ambiguous to
 *  trust to a key, so we return null and let the caller route to a human. */
const MATCH_GATE = 0.55;

type Embed = (texts: string[]) => Promise<number[][]>;

let embedderPromise: Promise<Embed | null> | undefined;

/** Lazily load MiniLM once. Returns null (cached) if it can't load — offline-safe. */
function getEmbedder(): Promise<Embed | null> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      try {
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        return async (texts: string[]) => {
          const t = await extractor(texts, { pooling: 'mean', normalize: true });
          return t.tolist() as number[][];
        };
      } catch {
        return null; // model unavailable → caller falls to HITL
      }
    })();
  }
  return embedderPromise;
}

/** Dot product. Vectors are L2-normalized by the extractor, so dot === cosine. */
function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Return the candidate key whose prototype phrases are closest in meaning to
 * `label`, with its cosine score — or null when nothing clears the gate or the
 * model is unavailable. `candidates` maps a key to one or more prototype
 * phrases; a key's score is the best (max) cosine over its phrases.
 */
export async function matchLabel(
  label: string,
  candidates: Record<string, string[]>,
): Promise<{ key: string; score: number } | null> {
  const text = (label || '').trim();
  if (!text) return null;

  const protos: Array<{ key: string; phrase: string }> = [];
  for (const key of Object.keys(candidates)) {
    for (const phrase of candidates[key]) protos.push({ key, phrase });
  }
  if (protos.length === 0) return null;

  const embed = await getEmbedder();
  if (!embed) return null;

  let vectors: number[][];
  try {
    vectors = await embed([text, ...protos.map((p) => p.phrase)]);
  } catch {
    return null; // embedding failed → offline-safe null
  }

  const labelVec = vectors[0];
  const best = new Map<string, number>();
  protos.forEach((p, i) => {
    const score = cosine(labelVec, vectors[i + 1]);
    const cur = best.get(p.key);
    if (cur === undefined || score > cur) best.set(p.key, score);
  });

  let bestKey = '';
  let bestScore = -Infinity;
  for (const [key, score] of best) {
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestScore >= MATCH_GATE ? { key: bestKey, score: bestScore } : null;
}
