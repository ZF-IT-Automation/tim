"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMEMBER_FALLBACK_MARKER = void 0;
exports.buildRerankPrompt = buildRerankPrompt;
exports.parseRerankOutput = parseRerankOutput;
exports.estimateTokens = estimateTokens;
exports.appendRememberLog = appendRememberLog;
exports.rememberRerank = rememberRerank;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const generate_summary_js_1 = require("./generate-summary.js");
exports.REMEMBER_FALLBACK_MARKER = 'TIM_REMEMBER_FALLBACK_NEEDED';
function buildRerankPrompt(input) {
    return (`You are a TIM memory recall assistant. Your ONLY task: rank the candidates below ` +
        `by semantic relevance to the user's query.\n\n` +
        `Query: "${input.query}"\n\n` +
        `Candidates (${input.candidates.length} total):\n` +
        `${JSON.stringify(input.candidates, null, 0)}\n\n` +
        (input.batchSummaries?.length
            ? `Recent batch summaries (recency context):\n${JSON.stringify(input.batchSummaries)}\n\n`
            : '') +
        `Return a strict JSON array, sorted by confidence descending, max ${input.topK * 2} entries:\n` +
        `[{"node_id": "<ULID>", "confidence": <0.0-1.0>, "reasoning": "<max 120 chars>"}]\n\n` +
        `Rules:\n` +
        `- confidence = YOUR semantic-relevance estimate (not word-match).\n` +
        `- Skip candidates with confidence < 0.2 (don't include them).\n` +
        `- Output ONLY the JSON array, no prose, no markdown fences.\n` +
        `- If no candidate matches, return [].\n` +
        `- If the chain fails entirely, output exactly: ${exports.REMEMBER_FALLBACK_MARKER}\n`);
}
function parseRerankOutput(text, maxTopK) {
    let s = text.trim();
    if (s.startsWith('```')) {
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }
    let parsed;
    try {
        parsed = JSON.parse(s);
    }
    catch {
        return null;
    }
    if (!Array.isArray(parsed))
        return null;
    const ranked = [];
    for (const item of parsed) {
        if (typeof item !== 'object' || item === null)
            continue;
        const row = item;
        const nodeId = row.node_id;
        const confidence = row.confidence;
        const reasoning = row.reasoning;
        if (typeof nodeId === 'string' &&
            typeof confidence === 'number' &&
            confidence >= 0 &&
            confidence <= 1 &&
            typeof reasoning === 'string') {
            ranked.push({
                node_id: nodeId,
                confidence,
                reasoning: reasoning.slice(0, 120),
            });
        }
    }
    ranked.sort((a, b) => b.confidence - a.confidence);
    return ranked.slice(0, maxTopK * 2);
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function appendRememberLog(line) {
    try {
        const logPath = path.join((0, tim_core_1.getTimDir)(), 'remember.log');
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // ignore log write failures
    }
}
async function rememberRerank(input) {
    const config = (0, tim_core_1.loadConfig)();
    const chain = config.remember?.chain;
    if (!chain || chain.length === 0) {
        return {
            ranked: null,
            model: 'none',
            tokensIn: 0,
            tokensOut: 0,
            fallback: 'all_chain_failed',
        };
    }
    const prompt = buildRerankPrompt(input);
    const timeoutSec = config.remember?.timeout_sec ?? 5;
    for (const entry of chain) {
        const result = await (0, generate_summary_js_1.tryCli)(entry.cli, entry.model, entry.provider, prompt, timeoutSec);
        if (!result)
            continue;
        const label = entry.provider
            ? `${entry.cli}/${entry.provider}/${entry.model}`
            : `${entry.cli}/${entry.model}`;
        if (result === exports.REMEMBER_FALLBACK_MARKER)
            continue;
        const ranked = parseRerankOutput(result, input.topK);
        if (ranked === null) {
            appendRememberLog(`INVALID_JSON ${label}: ${result.slice(0, 200)}`);
            continue;
        }
        return {
            ranked,
            model: label,
            tokensIn: estimateTokens(prompt),
            tokensOut: estimateTokens(result),
            fallback: 'none',
        };
    }
    return {
        ranked: null,
        model: 'chain-exhausted',
        tokensIn: 0,
        tokensOut: 0,
        fallback: 'all_chain_failed',
    };
}
const isMain = process.argv[1]?.endsWith('remember-query.js') || process.argv[1]?.endsWith('remember-query.ts');
if (isMain) {
    let stdinData = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        stdinData += chunk;
    });
    process.stdin.on('end', async () => {
        try {
            const input = JSON.parse(stdinData);
            const result = await rememberRerank(input);
            process.stdout.write(JSON.stringify(result));
        }
        catch {
            process.stdout.write(JSON.stringify({
                ranked: null,
                model: 'parse-error',
                tokensIn: 0,
                tokensOut: 0,
                fallback: 'error',
            }));
        }
    });
}
//# sourceMappingURL=remember-query.js.map