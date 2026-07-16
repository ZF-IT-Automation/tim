"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readJsonStdin = readJsonStdin;
exports.promptSubmitEnvelope = promptSubmitEnvelope;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;
async function readJsonStdin(maxBytes = DEFAULT_MAX_STDIN_BYTES) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        bytes += buffer.byteLength;
        if (bytes > maxBytes)
            return null;
        chunks.push(buffer);
    }
    if (bytes === 0)
        return null;
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function promptSubmitEnvelope(context) {
    return {
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
        },
    };
}
//# sourceMappingURL=claude-hook-io.js.map