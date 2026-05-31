"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHookScript = runHookScript;
exports.runHooks = runHooks;
exports.runConfiguredHooks = runConfiguredHooks;
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
//# sourceMappingURL=hooks.js.map