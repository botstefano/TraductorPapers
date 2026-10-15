export interface ReferenceMatch {
  referenceText: string;
  matchedSourceTitle?: string | null;
  similarity: number;
  isTranslatedSource: boolean;
}

export interface DocumentResult {
  id: string;
  filename: string;
  title: string;
  originalText: string;
  translatedText: string;
  references: ReferenceMatch[];
  elapsedSeconds: number;
  wordsCount: number;
  charsCount: number;
  paragraphsCount: number;
}

const REFERENCES_HEADERS = [
  "references",
  "bibliography",
  "works cited",
  "referencias",
  "bibliografía",
  "literature cited",
];

export function extractTitleFromText(fullText: string, filename: string): string {
  const lines = fullText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > 0) {
    for (const candidate of lines.slice(0, 8)) {
      const lower = candidate.toLowerCase();
      if (
        candidate.length > 6 &&
        candidate.length < 250 &&
        !lower.startsWith("arxiv:") &&
        !lower.startsWith("doi:") &&
        !lower.startsWith("http") &&
        !lower.startsWith("page ") &&
        !lower.startsWith("vol.") &&
        !lower.startsWith("issn") &&
        !lower.startsWith("journal of") &&
        !lower.startsWith("proceedings")
      ) {
        return candidate;
      }
    }
  }

  const base = filename.replace(/\.[^/.]+$/, "");
  return base
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function splitBodyAndReferences(fullText: string): { bodyText: string; referencesBlock: string } {
  const lower = fullText.toLowerCase();
  let cutIdx = -1;

  for (const header of REFERENCES_HEADERS) {
    const regex = new RegExp(`\n\\s*${header}\\s*\n`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lower)) !== null) {
      if (match.index > cutIdx) {
        cutIdx = match.index;
      }
    }
  }

  if (cutIdx === -1) {
    return { bodyText: fullText, referencesBlock: "" };
  }

  return {
    bodyText: fullText.substring(0, cutIdx).trim(),
    referencesBlock: fullText.substring(cutIdx).trim(),
  };
}

export function cleanAcademicText(raw: string): string {
  if (!raw) return "";

  let cleaned = raw
    // Rejoin words broken by hyphens across linebreaks (e.g., "repre-\nsentation" -> "representation")
    .replace(/([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g, "$1$2")
    // Remove arXiv headers like "arXiv:2301.12345v1 [cs.CL] 15 Jan 2023"
    .replace(/arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*(?:\[[^\]]+\])?\s*(?:\d{1,2}\s+[A-Za-z]+\s+\d{4})?/gi, "")
    // Remove "Page X of Y" or "Page X"
    .replace(/(?:^|\n)\s*page\s+\d+(?:\s*(?:of|\/)\s*\d+)?\s*(?=\n|$)/gi, "\n")
    // Remove standalone running header/footer page numbers (e.g., single digit or 2-3 digit line at boundary)
    .replace(/(?:^|\n)\s*\d{1,3}\s*(?=\n)/g, "\n")
    // Remove conference boilerplate (e.g. "Preprint. Under review.", "IEEE TRANSACTIONS ON...")
    .replace(/(?:^|\n)\s*(?:preprint|accepted as a conference paper|under review)[^\n]*\n/gi, "\n")
    // Normalize multiple consecutive blank lines into double newline
    .replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

export function parseReferenceItems(referencesBlock: string): string[] {
  if (!referencesBlock.trim()) return [];

  const cleanedBlock = referencesBlock
    .replace(/^.*?(?:references|bibliography|bibliografía|referencias)\s*\n/i, "")
    .trim();

  // Pattern A: Numbered bracket style "[1] ...", "[2] ..."
  const bracketRegex = /(?:^|\n)\s*\[(\d+)\]\s+([\s\S]+?)(?=(?:\n\s*\[\d+\])|\Z)/g;
  const bracketMatches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = bracketRegex.exec(cleanedBlock)) !== null) {
    const text = m[2].replace(/\n+/g, " ").trim();
    if (text.length > 8) {
      bracketMatches.push(`[${m[1]}] ${text}`);
    }
  }

  if (bracketMatches.length >= 2) {
    return bracketMatches;
  }

  // Pattern B: Numbered period style "1. ...", "2. ..."
  const numberedRegex = /(?:^|\n)\s*(\d{1,3})\.\s+([\s\S]+?)(?=(?:\n\s*\d{1,3}\.)|\Z)/g;
  const numberedMatches: string[] = [];

  while ((m = numberedRegex.exec(cleanedBlock)) !== null) {
    const text = m[2].replace(/\n+/g, " ").trim();
    if (text.length > 8) {
      numberedMatches.push(`${m[1]}. ${text}`);
    }
  }

  if (numberedMatches.length >= 2) {
    return numberedMatches;
  }

  // Pattern C: APA / Harvard / Author-Year style
  // Matches references starting with Author names and containing (19XX) or (20XX)
  const apaRegex = /(?:^|\n)\s*([A-Z][A-Za-zÀ-ÿ'\-]+,\s+[A-Z]\.[\s\S]+?\((?:19|20)\d{2}[a-z]?\)[\s\S]+?)(?=(?:\n\s*[A-Z][A-Za-zÀ-ÿ'\-]+,\s+[A-Z]\.)|\Z)/g;
  const apaMatches: string[] = [];

  while ((m = apaRegex.exec(cleanedBlock)) !== null) {
    const text = m[1].replace(/\n+/g, " ").trim();
    if (text.length > 15) {
      apaMatches.push(text);
    }
  }

  if (apaMatches.length >= 2) {
    return apaMatches;
  }

  // Fallback: split by double newlines
  const paragraphs = cleanedBlock
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\n+/g, " ").trim())
    .filter((s) => s.length > 20 && !REFERENCES_HEADERS.includes(s.toLowerCase()));

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  // Fallback 2: split by single lines that look like citations
  return cleanedBlock
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

// Levenshtein distance
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }

  return curr[n];
}

function levenshteinRatio(s1: string, s2: string): number {
  const totalLen = s1.length + s2.length;
  if (totalLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return (totalLen - dist) / totalLen;
}

export function tokenSetRatio(str1: string, str2: string): number {
  const clean1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const clean2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, " ");

  const tokens1 = new Set(clean1.split(/\s+/).filter((t) => t.length > 1));
  const tokens2 = new Set(clean2.split(/\s+/).filter((t) => t.length > 1));

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = [...tokens1].filter((t) => tokens2.has(t));
  const diff1 = [...tokens1].filter((t) => !tokens2.has(t));
  const diff2 = [...tokens2].filter((t) => !tokens1.has(t));

  const s0 = intersection.sort().join(" ");
  const s1 = (s0 + " " + diff1.sort().join(" ")).trim();
  const s2 = (s0 + " " + diff2.sort().join(" ")).trim();

  // If title has high overlap with reference or is substantially contained
  if (tokens2.size > 0 && intersection.length >= Math.min(tokens2.size, 4)) {
    const containmentRatio = intersection.length / tokens2.size;
    if (containmentRatio >= 0.7) {
      return Math.max(90, Math.round(containmentRatio * 100));
    }
  }

  const r01 = levenshteinRatio(s0, s1);
  const r02 = levenshteinRatio(s0, s2);
  const r12 = levenshteinRatio(s1, s2);

  const bestRatio = Math.max(r01, r02, r12);
  return Math.round(bestRatio * 100);
}

export function crossCheckReferences(
  referenceItems: string[],
  otherSourceTitles: string[],
  threshold = 55
): ReferenceMatch[] {
  return referenceItems.map((ref) => {
    let bestTitle: string | null = null;
    let bestScore = 0;

    for (const title of otherSourceTitles) {
      if (!title || title.trim().length < 4) continue;
      const score = tokenSetRatio(ref, title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }

    const isMatch = bestScore >= threshold;
    return {
      referenceText: ref,
      matchedSourceTitle: isMatch ? bestTitle : null,
      similarity: bestScore,
      isTranslatedSource: isMatch,
    };
  });
}
