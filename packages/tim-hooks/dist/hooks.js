"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHookScript = runHookScript;
exports.runHooks = runHooks;
exports.runConfiguredHooks = runConfiguredHooks;
exports.embedUnembeddedEntries = embedUnembeddedEntries;
const child_process_1 = require("child_process");
const tim_core_1 = require("tim-core");
async function runHookScript(script, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const env = { ...process.env, ...options.env };
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(script, {
            shell: true,
            env,
            cwd: options.cwd,
            stdio: 'ignore',
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                script,
                exitCode: null,
                signal: null,
                timedOut: false,
                error: err.message,
            });
        });
        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
                script,
                exitCode,
                signal,
                timedOut,
            });
        });
    });
}
async function runHooks(options = {}) {
    const scripts = (0, tim_core_1.normalizeHookScripts)(options.scripts);
    const results = [];
    for (const script of scripts) {
        const result = await runHookScript(script, options);
        results.push(result);
        if (result.error) {
            console.error(`[tim-hooks] hook failed to start (${script}): ${result.error}`);
        }
        else if (result.timedOut) {
            console.error(`[tim-hooks] hook timed out (${script}) after ${options.timeoutMs ?? 30_000}ms`);
        }
        else if (result.exitCode !== 0) {
            console.error(`[tim-hooks] hook exited with code ${result.exitCode} (${script})`);
        }
    }
    return results;
}
async function runConfiguredHooks(hookName, hooksConfig, env) {
    if (hooksConfig?.enabled === false) {
        return [];
    }
    const scripts = hooksConfig?.[hookName];
    return runHooks({
        scripts,
        env,
        timeoutMs: hooksConfig?.timeoutMs ?? 30_000,
        cwd: env.TIM_CWD,
    });
}
function resolveEmbeddingModel(name) {
    if (name === 'all-MiniLM-L6-v2')
        return 'fast-all-MiniLM-L6-v2';
    return name;
}
function resolveEmbeddingModelEnum(name, EmbeddingModel) {
    const resolved = resolveEmbeddingModel(name);
    const match = Object.values(EmbeddingModel).find(v => v === resolved);
    return (match ?? EmbeddingModel.AllMiniLML6V2);
}
/**
 * Background hook: finds unembedded content entries and computes their
 * vectors via fastembed (local ONNX). Runs in the summarizer-style
 * fallback chain — best-effort, never blocks user flows.
 *
 * Set TIM_EMBEDDING_DISABLED=1 to skip entirely.
 */
async function embedUnembeddedEntries(store, opts = {}) {
    if (process.env.TIM_EMBEDDING_DISABLED === '1')
        return 0;
    const batchSize = opts.batchSize ?? (Number(process.env.TIM_EMBEDDING_BATCH_SIZE) || 32);
    const modelName = resolveEmbeddingModel(opts.model ?? process.env.TIM_EMBEDDING_MODEL ?? 'all-MiniLM-L6-v2');
    let entries;
    try {
        entries = await store.getUnembedded(batchSize);
    }
    catch {
        return 0;
    }
    if (entries.length === 0)
        return 0;
    try {
        const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
        const modelEnum = resolveEmbeddingModelEnum(modelName, EmbeddingModel);
        const embedder = await FlagEmbedding.init({ model: modelEnum });
        const texts = entries.map(e => e.content.slice(0, 2000));
        const gen = embedder.embed(texts, batchSize);
        const batch = await gen.next();
        const vectors = batch.value;
        if (!vectors)
            return 0;
        let embedded = 0;
        for (let i = 0; i < entries.length; i++) {
            try {
                store.setVectors(entries[i].id, new Float32Array(vectors[i]), modelName);
                embedded++;
            }
            catch {
                // individual entry failure — continue with next
            }
        }
        return embedded;
    }
    catch (err) {
        console.debug('[tim-hooks] embedUnembeddedEntries: embedding not available:', err.message);
        return 0;
    }
}
//# sourceMappingURL=hooks.js.map