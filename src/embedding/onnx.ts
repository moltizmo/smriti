import type { EmbeddingEngine } from "./engine.js";

// @xenova/transformers is a CJS module with default export
let pipeline: any;

async function loadPipeline() {
  if (!pipeline) {
    const { pipeline: pipelineFn } = await import("@xenova/transformers");
    pipeline = await pipelineFn("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return pipeline;
}

export class OnnxEmbeddingEngine implements EmbeddingEngine {
  private pipe: any = null;

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) {
      this.pipe = await loadPipeline();
    }
    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  dimension(): number {
    return 384;
  }
}
