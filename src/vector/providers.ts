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

export class TransformerEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly isLocal = true;
  private pipelinePromise: Promise<FeaturePipeline> | undefined;
  private readonly cacheDir: string | undefined;

  constructor(model = DEFAULT_LOCAL_MODEL, cacheDir?: string) {
    this.model = model;
    this.cacheDir = cacheDir;
  }

  private pipeline(): Promise<FeaturePipeline> {
    return (this.pipelinePromise ??= (async () => {
      const transformers = await import('@huggingface/transformers');
      if (this.cacheDir) transformers.env.cacheDir = this.cacheDir;
      transformers.env.allowRemoteModels = true;
      return await transformers.pipeline('feature-extraction', this.model, { dtype: 'q8' }) as unknown as FeaturePipeline;
    })());
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
    if (this.pipelinePromise) await (await this.pipelinePromise).dispose();
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
