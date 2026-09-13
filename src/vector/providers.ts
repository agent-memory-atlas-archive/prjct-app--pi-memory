export interface EmbeddingProvider {
  readonly model: string;
  readonly isLocal: boolean;
  embed(texts: readonly string[], options?: { signal?: AbortSignal; inputType?: 'query' | 'passage' }): Promise<number[][]>;
  dispose?(): Promise<void>;
}

export type EmbeddingConfig = Readonly<{
  provider?: 'local' | 'openai-compatible';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  cacheDir?: string;
}>;

type FeaturePipeline = ((texts: string[], options: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) & { dispose(): Promise<void> };

export const DEFAULT_LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/**
 * One loaded model per (model, cacheDir), shared by every provider that asks
 * for it and released when the last one lets go. A session that reads its
 * project, the shared scope and four teams holds six engines; without this each
 * would load its own copy of the encoder and its own inference session.
 */
type SharedPipeline = { pipeline: Promise<FeaturePipeline>; refs: number };
const loaded = new Map<string, SharedPipeline>();

const loads = { count: 0 };

const loadPipeline = async (model: string, cacheDir: string | undefined): Promise<FeaturePipeline> => {
  loads.count += 1;
  const transformers = await import('@huggingface/transformers');
  if (cacheDir) transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = true;
  return await transformers.pipeline('feature-extraction', model, { dtype: 'q8' }) as unknown as FeaturePipeline;
};

/** How many encoders are resident. */
export const residentModels = (): number => loaded.size;
/**
 * How many times an encoder has actually been loaded in this process. Counting
 * resident entries is not enough to prove sharing — six unshared loads still
 * leave one entry under one key.
 */
export const encoderLoads = (): number => loads.count;

export class TransformerEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly isLocal = true;
  private readonly cacheDir: string | undefined;
  private held: string | undefined;

  constructor(model = DEFAULT_LOCAL_MODEL, cacheDir?: string) {
    this.model = model;
    this.cacheDir = cacheDir;
  }

  private pipeline(): Promise<FeaturePipeline> {
    const key = `${this.model}\u0000${this.cacheDir ?? ''}`;
    const existing = loaded.get(key);
    // A failed load is not cached: the model may be missing only because the
    // network was, and the next caller deserves a fresh attempt rather than the
    // first caller's rejection forever.
    const entry = existing ?? { refs: 0, pipeline: loadPipeline(this.model, this.cacheDir)
      .catch((error: unknown) => { loaded.delete(key); throw error; }) };
    // Counted on first use, not on construction: a provider that never embeds
    // never loads anything and has nothing to release.
    if (this.held === undefined) {
      entry.refs += 1;
      this.held = key;
    }
    loaded.set(key, entry);
    return entry.pipeline;
  }

  async embed(texts: readonly string[], options: { signal?: AbortSignal; inputType?: 'query' | 'passage' } = {}): Promise<number[][]> {
    options.signal?.throwIfAborted();
    const extractor = await this.pipeline();
    options.signal?.throwIfAborted();
    const output = await extractor([...texts], { pooling: 'mean', normalize: true });
    options.signal?.throwIfAborted();
    return output.tolist();
  }

  async dispose(): Promise<void> {
    const key = this.held;
    if (key === undefined) return;
    this.held = undefined;
    const entry = loaded.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    loaded.delete(key);
    // The pipeline may have failed to load; releasing must not resurrect that
    // rejection at session shutdown.
    const resolved = await entry.pipeline.catch(() => undefined);
    await resolved?.dispose().catch(() => undefined);
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly isLocal = false;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly dimensions: number | undefined;

  constructor(config: Required<Pick<EmbeddingConfig, 'model' | 'baseUrl'>> & Pick<EmbeddingConfig, 'apiKey' | 'dimensions'>) {
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.dimensions = config.dimensions;
  }

  async embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST', signal: options.signal,
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ input: texts, model: this.model, ...(this.dimensions ? { dimensions: this.dimensions } : {}) }),
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length || data.some(row => !Array.isArray(row.embedding) || row.embedding.length < 8)) throw new Error('Embedding provider returned an invalid batch.');
    return data.map(row => row.embedding);
  }
}

export const createEmbeddingProvider = (config: EmbeddingConfig = {}): EmbeddingProvider => {
  if (config.provider === 'openai-compatible') {
    if (!config.model || !config.baseUrl) throw new Error('Remote embeddings require model and baseUrl.');
    return new OpenAICompatibleEmbeddingProvider({ model: config.model, baseUrl: config.baseUrl,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}), ...(config.dimensions ? { dimensions: config.dimensions } : {}) });
  }
  return new TransformerEmbeddingProvider(config.model ?? DEFAULT_LOCAL_MODEL, config.cacheDir);
};
