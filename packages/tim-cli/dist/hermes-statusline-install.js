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
exports.resolveHermesScriptsDir = resolveHermesScriptsDir;
exports.resolveTimRepoRoot = resolveTimRepoRoot;
exports.ensureCacheHookInConfig = ensureCacheHookInConfig;
exports.isHermesCliBroken = isHermesCliBroken;
exports.isHermesCliPatched = isHermesCliPatched;
exports.isHermesCliHmemPatched = isHermesCliHmemPatched;
exports.patchHermesCliSource = patchHermesCliSource;
exports.auditHermesStatusline = auditHermesStatusline;
exports.installHermesStatusline = installHermesStatusline;
exports.printHermesInstallReport = printHermesInstallReport;
exports.cmdSetupHermesStatusline = cmdSetupHermesStatusline;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const CACHE_HOOK = 'tim-hermes-session-cache.sh';
const STATUSLINE_HOOK = 'tim-hermes-statusline.sh';
const SCRIPT_NAMES = [CACHE_HOOK, STATUSLINE_HOOK];
function moduleDir() {
    return path.dirname(__filename);
}
/** Resolve packaged scripts dir (npm) or monorepo dev path. */
function resolveHermesScriptsDir() {
    try {
        const hooksPkg = path.dirname(require.resolve('tim-hooks/package.json'));
        const packaged = path.join(hooksPkg, 'scripts');
        if (fs.existsSync(path.join(packaged, CACHE_HOOK)))
            return packaged;
    }
    catch {
        /* not installed via npm layout */
    }
    const dev = path.resolve(moduleDir(), '../../tim-hooks/scripts');
    if (fs.existsSync(path.join(dev, CACHE_HOOK)))
        return dev;
    throw new Error('TIM Hermes scripts not found. Run from TIM repo or reinstall tim-cli/tim-hooks.');
}
function resolveTimRepoRoot(scriptsDir) {
    const candidate = path.resolve(scriptsDir, '../../..');
    const pkg = path.join(candidate, 'packages', 'tim-cli', 'package.json');
    return fs.existsSync(pkg) ? candidate : null;
}
function ensureCacheHookInConfig(yaml) {
    if (yaml.includes(CACHE_HOOK))
        return { yaml, changed: false };
    const hookBlock = '  - command: ~/.hermes/agent-hooks/tim-hermes-session-cache.sh\n    timeout: 10\n';
    const afterStartup = /(- command:.*o9k-startup\.sh[^\n]*\n(?:    timeout: [^\n]+\n)?)/;
    const m = yaml.match(afterStartup);
    if (m?.index !== undefined) {
        const insertAt = m.index + m[0].length;
        return {
            yaml: yaml.slice(0, insertAt) + hookBlock + yaml.slice(insertAt),
            changed: true,
        };
    }
    const preHeader = /(hooks:\s*\n\s*pre_llm_call:\s*\n)/;
    const p = yaml.match(preHeader);
    if (p?.index !== undefined) {
        const insertAt = p.index + p[0].length;
        return {
            yaml: yaml.slice(0, insertAt) + hookBlock + yaml.slice(insertAt),
            changed: true,
        };
    }
    throw new Error('Could not find hooks.pre_llm_call in ~/.hermes/config.yaml');
}
/** Broken TIM patch: @staticmethod landed on _get_tim_status instead of display_width. */
function isHermesCliBroken(cliPy) {
    return (cliPy.includes('@staticmethod\n    def _get_tim_status') ||
        (cliPy.includes('_get_tim_status') &&
            !cliPy.includes('@staticmethod\n    def _status_bar_display_width')));
}
function isHermesCliPatched(cliPy) {
    return cliPy.includes('_get_tim_status') && !isHermesCliBroken(cliPy);
}
function isHermesCliHmemPatched(cliPy) {
    return cliPy.includes('_get_hmem_status');
}
const TIM_STATUS_METHOD = `    def _get_tim_status(self) -> Dict[str, str]:
        """Call tim-hermes-statusline.sh for TIM project / batch counter."""
        try:
            import subprocess, json
            script = os.path.expanduser("~/.hermes/agent-hooks/tim-hermes-statusline.sh")
            if not os.path.isfile(script):
                return {}
            result = subprocess.run(
                ["bash", script], capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0 and result.stdout.strip():
                return json.loads(result.stdout)
        except Exception:
            pass
        return {}

`;
const TIM_PREFIX_BLOCK = `
            tim = self._get_tim_status()
            tim_prefix = ""
            if tim:
                parts = []
                if tim.get("device"):
                    parts.append(tim["device"])
                proj = tim.get("project", "")
                o_node = tim.get("o_node", "")
                if o_node:
                    proj = f"{proj} → {o_node}"
                if proj:
                    parts.append(proj)
                if tim.get("counter"):
                    parts.append(tim["counter"])
                if parts:
                    tim_prefix = " │ ".join(parts)

`;
/** Programmatic cli.py patch (Hermes line numbers drift; git patch is reference only). */
function patchHermesCliSource(source) {
    if (isHermesCliPatched(source) && !isHermesCliBroken(source)) {
        return { source, changed: false };
    }
    let out = source;
    let changed = false;
    if (isHermesCliHmemPatched(source)) {
        out = out
            .replace(/~\/\.hermes\/agent-hooks\/hmem-statusline\.sh/g, '~/.hermes/agent-hooks/tim-hermes-statusline.sh')
            .replace(/def _get_hmem_status\(/g, 'def _get_tim_status(')
            .replace(/self\._get_hmem_status\(\)/g, 'self._get_tim_status()')
            .replace(/\bhmem_prefix\b/g, 'tim_prefix')
            .replace(/\bhmem = self\._get_tim_status\(\)/g, 'tim = self._get_tim_status()')
            .replace(/if hmem_prefix:/g, 'if tim_prefix:')
            .replace(/if hmem:/g, 'if tim:')
            .replace(/if hmem\.get\(/g, 'if tim.get(');
        return { source: out, changed: true };
    }
    const staticWidthAnchor = '    @staticmethod\n    def _status_bar_display_width(text: str) -> int:';
    const brokenTimAnchor = '    @staticmethod\n    def _get_tim_status(self) -> Dict[str, str]:';
    const plainWidthAnchor = '    def _status_bar_display_width(text: str) -> int:';
    if (out.includes(brokenTimAnchor) && out.includes(plainWidthAnchor)) {
        out = out.replace(brokenTimAnchor, '    def _get_tim_status(self) -> Dict[str, str]:');
        out = out.replace(plainWidthAnchor, staticWidthAnchor);
        changed = true;
    }
    else if (out.includes(staticWidthAnchor)) {
        if (!out.includes('_get_tim_status')) {
            out = out.replace(staticWidthAnchor, TIM_STATUS_METHOD + staticWidthAnchor);
            changed = true;
        }
    }
    else if (out.includes(plainWidthAnchor)) {
        out = out.replace(plainWidthAnchor, TIM_STATUS_METHOD + staticWidthAnchor);
        changed = true;
    }
    else {
        throw new Error('Hermes cli.py: anchor _status_bar_display_width not found — update TIM patcher');
    }
    if (!out.includes(staticWidthAnchor)) {
        throw new Error('Hermes cli.py: @staticmethod lost on _status_bar_display_width');
    }
    const durAnchor = '            duration_label = snapshot["duration"]\n            yolo_active = self._is_session_yolo_active()';
    if (out.includes(durAnchor) && !out.includes('tim = self._get_tim_status()')) {
        out = out.replace(durAnchor, durAnchor + TIM_PREFIX_BLOCK);
        changed = true;
    }
    const wideFragsOld = `                    frags = [
                        ("class:status-bar", " ⚕ "),
                        ("class:status-bar-strong", snapshot["model_short"]),
                        ("class:status-bar-dim", " │ "),
                        ("class:status-bar-dim", context_label),
                        ("class:status-bar-dim", " │ "),
                        (bar_style, self._build_context_bar(percent)),
                        ("class:status-bar-dim", " "),
                        (bar_style, percent_label),
                    ]`;
    const wideFragsNew = `                    frags = []
                    if tim_prefix:
                        frags.append(("class:status-bar-strong", f" {tim_prefix}"))
                        frags.append(("class:status-bar-dim", " │ "))
                    frags.extend([
                        ("class:status-bar", " ⚕ "),
                        ("class:status-bar-strong", snapshot["model_short"]),
                        ("class:status-bar-dim", " │ "),
                        ("class:status-bar-dim", context_label),
                        ("class:status-bar-dim", " │ "),
                        (bar_style, self._build_context_bar(percent)),
                        ("class:status-bar-dim", " "),
                        (bar_style, percent_label),
                    ])`;
    if (out.includes(wideFragsOld)) {
        out = out.replace(wideFragsOld, wideFragsNew);
        changed = true;
    }
    if (!out.includes('_get_tim_status')) {
        throw new Error('Hermes cli.py: failed to inject _get_tim_status');
    }
    if (source.includes(durAnchor) && !out.includes('tim = self._get_tim_status()')) {
        throw new Error('Hermes cli.py: TIM method added but status-bar fragment hook did not match — update TIM or patch manually');
    }
    return { source: out, changed };
}
function symlinkHook(src, dest, dryRun) {
    const srcAbs = path.resolve(src);
    if (dryRun) {
        if (!fs.existsSync(dest))
            return 'created';
        try {
            return fs.realpathSync(dest) === srcAbs ? 'ok' : 'updated';
        }
        catch {
            return 'updated';
        }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
        try {
            if (fs.realpathSync(dest) === srcAbs)
                return 'ok';
        }
        catch {
            /* broken symlink */
        }
        fs.rmSync(dest, { force: true });
    }
    fs.symlinkSync(srcAbs, dest);
    return 'created';
}
function push(steps, step, status, detail) {
    steps.push({ step, status, detail });
}
/** Read-only check for `tim doctor` (no writes). */
function auditHermesStatusline(opts = {}) {
    const issues = [];
    const hooksDir = opts.hooksDir ?? path.join(os.homedir(), '.hermes', 'agent-hooks');
    const configPath = opts.configPath ?? path.join(os.homedir(), '.hermes', 'config.yaml');
    const cliPy = path.join(opts.hermesAgentDir ?? path.join(os.homedir(), '.hermes', 'hermes-agent'), 'cli.py');
    for (const name of SCRIPT_NAMES) {
        const dest = path.join(hooksDir, name);
        if (!fs.existsSync(dest))
            issues.push(`missing hook: ${dest}`);
    }
    if (fs.existsSync(configPath)) {
        const yaml = fs.readFileSync(configPath, 'utf8');
        if (!yaml.includes(CACHE_HOOK))
            issues.push(`config.yaml: ${CACHE_HOOK} not in pre_llm_call`);
    }
    else {
        issues.push(`config.yaml not found: ${configPath}`);
    }
    if (fs.existsSync(cliPy)) {
        const src = fs.readFileSync(cliPy, 'utf8');
        if (isHermesCliBroken(src)) {
            issues.push('cli.py: broken TIM patch (@staticmethod on wrong method) — re-run setup');
        }
        else if (!isHermesCliPatched(src)) {
            issues.push('cli.py: _get_tim_status missing');
        }
        else if (!src.includes('tim = self._get_tim_status()')) {
            issues.push('cli.py: status-bar fragment hook incomplete');
        }
    }
    else {
        issues.push(`cli.py not found: ${cliPy}`);
    }
    return { installed: issues.length === 0, issues };
}
async function installHermesStatusline(opts = {}) {
    const steps = [];
    const dryRun = opts.dryRun ?? false;
    const hooksDir = opts.hooksDir ?? path.join(os.homedir(), '.hermes', 'agent-hooks');
    const configPath = opts.configPath ?? path.join(os.homedir(), '.hermes', 'config.yaml');
    const hermesAgentDir = opts.hermesAgentDir ?? path.join(os.homedir(), '.hermes', 'hermes-agent');
    let scriptsDir;
    try {
        scriptsDir = resolveHermesScriptsDir();
        push(steps, 'scripts', 'ok', scriptsDir);
    }
    catch (e) {
        push(steps, 'scripts', 'fail', e.message);
        return { steps, ok: false };
    }
    // 1. Symlinks + chmod
    for (const name of SCRIPT_NAMES) {
        const src = path.join(scriptsDir, name);
        const dest = path.join(hooksDir, name);
        if (!fs.existsSync(src)) {
            push(steps, `symlink:${name}`, 'fail', `source missing: ${src}`);
            return { steps, ok: false };
        }
        if (!dryRun) {
            fs.chmodSync(src, 0o755);
        }
        try {
            const action = symlinkHook(src, dest, dryRun);
            const label = action === 'created' ? 'symlink created' : action === 'updated' ? 'symlink updated' : 'already linked';
            push(steps, `symlink:${name}`, action === 'ok' ? 'skip' : 'ok', `${label} → ${dest}`);
        }
        catch (e) {
            push(steps, `symlink:${name}`, 'fail', e.message);
            return { steps, ok: false };
        }
    }
    // 2. config.yaml
    if (!fs.existsSync(configPath)) {
        push(steps, 'config.yaml', 'fail', `not found: ${configPath}`);
        return { steps, ok: false };
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const { yaml, changed } = ensureCacheHookInConfig(raw);
        if (!changed) {
            push(steps, 'config.yaml', 'skip', `${CACHE_HOOK} already registered`);
        }
        else if (dryRun) {
            push(steps, 'config.yaml', 'ok', `would insert ${CACHE_HOOK} under pre_llm_call`);
        }
        else {
            const backup = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
            fs.copyFileSync(configPath, backup);
            fs.writeFileSync(configPath, yaml);
            push(steps, 'config.yaml', 'ok', `added ${CACHE_HOOK} (backup: ${backup})`);
        }
    }
    catch (e) {
        push(steps, 'config.yaml', 'fail', e.message);
        return { steps, ok: false };
    }
    // 3. Hermes cli.py patch
    const cliPy = path.join(hermesAgentDir, 'cli.py');
    if (!fs.existsSync(cliPy)) {
        push(steps, 'hermes-cli', 'fail', `cli.py not found at ${cliPy} — set HERMES_AGENT_DIR or clone hermes-agent`);
        return { steps, ok: false };
    }
    const cliText = fs.readFileSync(cliPy, 'utf8');
    if (isHermesCliPatched(cliText)) {
        push(steps, 'hermes-cli', 'skip', '_get_tim_status already present');
    }
    else if (dryRun) {
        const mode = isHermesCliHmemPatched(cliText) ? 'convert hmem → tim' : 'inject _get_tim_status';
        push(steps, 'hermes-cli', 'ok', `would patch cli.py (${mode})`);
    }
    else {
        try {
            const { source, changed } = patchHermesCliSource(cliText);
            if (changed) {
                const backup = `${cliPy}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
                fs.copyFileSync(cliPy, backup);
                fs.writeFileSync(cliPy, source);
                push(steps, 'hermes-cli', 'ok', isHermesCliHmemPatched(cliText)
                    ? `retargeted hmem status bar to TIM (backup: ${backup})`
                    : `patched cli.py (backup: ${backup})`);
            }
            else {
                push(steps, 'hermes-cli', 'skip', 'no changes needed');
            }
        }
        catch (e) {
            push(steps, 'hermes-cli', 'fail', e.message);
            return { steps, ok: false };
        }
    }
    // 4. Build TIM CLI (monorepo dev only unless skip)
    if (opts.skipBuild) {
        push(steps, 'build', 'skip', '--skip-build');
    }
    else {
        const repoRoot = resolveTimRepoRoot(scriptsDir);
        if (!repoRoot) {
            push(steps, 'build', 'skip', 'not in TIM monorepo — using installed dist');
        }
        else if (dryRun) {
            push(steps, 'build', 'ok', `would run npx tsc -b in ${repoRoot}`);
        }
        else {
            try {
                (0, child_process_1.execSync)('npx tsc -b', { cwd: repoRoot, stdio: 'pipe' });
                push(steps, 'build', 'ok', 'npx tsc -b completed');
            }
            catch (e) {
                const msg = e.stderr?.toString() || e.message;
                push(steps, 'build', 'warn', `build failed: ${msg.slice(0, 200)}`);
            }
        }
    }
    // Verify JSON output
    const cliJs = path.join(moduleDir(), 'cli.js');
    if (!dryRun && fs.existsSync(cliJs)) {
        try {
            const sample = (0, child_process_1.execSync)(`node "${cliJs}" statusline --format hermes --cwd "${process.cwd()}"`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            JSON.parse(sample);
            push(steps, 'verify', 'ok', `statusline JSON: ${sample.slice(0, 80)}`);
        }
        catch {
            push(steps, 'verify', 'warn', 'tim statusline --format hermes did not return valid JSON');
        }
    }
    const failed = steps.some(s => s.status === 'fail');
    return { steps, ok: !failed };
}
function printHermesInstallReport(report) {
    console.log('\nTIM Hermes status bar setup\n');
    for (const s of report.steps) {
        const icon = s.status === 'ok' ? '✓' : s.status === 'skip' ? '○' : s.status === 'warn' ? '!' : '✗';
        console.log(`  ${icon} ${s.step}: ${s.detail}`);
    }
    console.log('');
    if (report.ok) {
        console.log('Done. Restart Hermes so cli.py changes load.');
        console.log('Test: bash ~/.hermes/agent-hooks/tim-hermes-statusline.sh | jq .\n');
    }
    else {
        console.log('Setup incomplete — fix failures above.\n');
        process.exitCode = 1;
    }
}
async function cmdSetupHermesStatusline(args) {
    const dryRun = args.includes('--dry-run');
    const skipBuild = args.includes('--skip-build');
    const hermesAgentDir = process.env.HERMES_AGENT_DIR?.trim();
    const report = await installHermesStatusline({
        dryRun,
        skipBuild,
        ...(hermesAgentDir ? { hermesAgentDir } : {}),
    });
    printHermesInstallReport(report);
}
//# sourceMappingURL=hermes-statusline-install.js.map