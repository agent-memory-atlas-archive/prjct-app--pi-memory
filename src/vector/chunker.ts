import type { DocumentChunk, SourceDocument } from '../contracts/documents.ts';
import { documentKey } from '../contracts/documents.ts';
import { sha256 } from '../workspace/project-identity.ts';

export type ChunkOptions = Readonly<{ targetChars?: number; overlapChars?: number; maxChunks?: number }>;

const splitLong = (text: string, target: number, overlap: number): string[] => {
  if (text.length <= target) return [text];
  const starts = Array.from({ length: Math.ceil(text.length / Math.max(1, target - overlap)) }, (_, index) => index * (target - overlap))
    .filter(start => start < text.length);
  return starts.map(start => text.slice(start, start + target)).filter(Boolean);
};

export const chunkDocument = (document: SourceDocument, options: ChunkOptions = {}): DocumentChunk[] => {
  const target = Math.max(256, Math.min(4096, options.targetChars ?? 1200));
  const overlap = Math.max(0, Math.min(Math.floor(target / 3), options.overlapChars ?? 160));
  const maxChunks = Math.max(1, Math.min(4096, options.maxChunks ?? 512));
  const paragraphs = document.text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
  const blocks = paragraphs.flatMap(paragraph => splitLong(paragraph, target, overlap));
  const folded = blocks.reduce<string[]>((chunks, block) => {
    const tail = chunks.at(-1);
    if (!tail || tail.length + block.length + 2 > target) return [...chunks, block];
    return [...chunks.slice(0, -1), `${tail}\n\n${block}`];
  }, []).slice(0, maxChunks);
  const key = documentKey(document);
  return folded.map((text, ordinal) => ({
    id: `chk_${sha256(`${key}\u0000${document.contentHash}\u0000${ordinal}\u0000${text}`).slice(0, 32)}`,
    documentKey: key, namespace: document.namespace, ordinal, text,
    contentHash: sha256(text), metadata: document.metadata,
  }));
};
