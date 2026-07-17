"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_TIM_SKILLS = exports.TIM_NEW_PROJECT_SKILL = exports.TIM_MCP_SMOKE_SKILL = exports.TIM_SECRET_AUDIT_SKILL = exports.TIM_SYNC_TRIAGE_SKILL = exports.TIM_PROJECT_CURATE_SKILL = exports.TIM_RELEASE_BETA_SKILL = exports.TIM_HMEM_IMPORT_AUDIT_SKILL = exports.TIM_SESSION_START_SKILL = exports.TIM_REMEMBER_SKILL = exports.TIM_USING_SKILL = exports.TIM_EXPLAIN_SKILL = exports.TIM_HANDOFF_SKILL = void 0;
exports.getSkill = getSkill;
exports.listSkills = listSkills;
const tim_handoff_js_1 = require("./tim-handoff.js");
const tim_explain_js_1 = require("./tim-explain.js");
const tim_using_js_1 = require("./tim-using.js");
const tim_remember_js_1 = require("./tim-remember.js");
const tim_session_start_js_1 = require("./tim-session-start.js");
const tim_hmem_import_audit_js_1 = require("./tim-hmem-import-audit.js");
const tim_release_beta_js_1 = require("./tim-release-beta.js");
const tim_project_curate_js_1 = require("./tim-project-curate.js");
const tim_sync_triage_js_1 = require("./tim-sync-triage.js");
const tim_secret_audit_js_1 = require("./tim-secret-audit.js");
const tim_mcp_smoke_js_1 = require("./tim-mcp-smoke.js");
const tim_new_project_js_1 = require("./tim-new-project.js");
var tim_handoff_js_2 = require("./tim-handoff.js");
Object.defineProperty(exports, "TIM_HANDOFF_SKILL", { enumerable: true, get: function () { return tim_handoff_js_2.TIM_HANDOFF_SKILL; } });
var tim_explain_js_2 = require("./tim-explain.js");
Object.defineProperty(exports, "TIM_EXPLAIN_SKILL", { enumerable: true, get: function () { return tim_explain_js_2.TIM_EXPLAIN_SKILL; } });
var tim_using_js_2 = require("./tim-using.js");
Object.defineProperty(exports, "TIM_USING_SKILL", { enumerable: true, get: function () { return tim_using_js_2.TIM_USING_SKILL; } });
var tim_remember_js_2 = require("./tim-remember.js");
Object.defineProperty(exports, "TIM_REMEMBER_SKILL", { enumerable: true, get: function () { return tim_remember_js_2.TIM_REMEMBER_SKILL; } });
var tim_session_start_js_2 = require("./tim-session-start.js");
Object.defineProperty(exports, "TIM_SESSION_START_SKILL", { enumerable: true, get: function () { return tim_session_start_js_2.TIM_SESSION_START_SKILL; } });
var tim_hmem_import_audit_js_2 = require("./tim-hmem-import-audit.js");
Object.defineProperty(exports, "TIM_HMEM_IMPORT_AUDIT_SKILL", { enumerable: true, get: function () { return tim_hmem_import_audit_js_2.TIM_HMEM_IMPORT_AUDIT_SKILL; } });
var tim_release_beta_js_2 = require("./tim-release-beta.js");
Object.defineProperty(exports, "TIM_RELEASE_BETA_SKILL", { enumerable: true, get: function () { return tim_release_beta_js_2.TIM_RELEASE_BETA_SKILL; } });
var tim_project_curate_js_2 = require("./tim-project-curate.js");
Object.defineProperty(exports, "TIM_PROJECT_CURATE_SKILL", { enumerable: true, get: function () { return tim_project_curate_js_2.TIM_PROJECT_CURATE_SKILL; } });
var tim_sync_triage_js_2 = require("./tim-sync-triage.js");
Object.defineProperty(exports, "TIM_SYNC_TRIAGE_SKILL", { enumerable: true, get: function () { return tim_sync_triage_js_2.TIM_SYNC_TRIAGE_SKILL; } });
var tim_secret_audit_js_2 = require("./tim-secret-audit.js");
Object.defineProperty(exports, "TIM_SECRET_AUDIT_SKILL", { enumerable: true, get: function () { return tim_secret_audit_js_2.TIM_SECRET_AUDIT_SKILL; } });
var tim_mcp_smoke_js_2 = require("./tim-mcp-smoke.js");
Object.defineProperty(exports, "TIM_MCP_SMOKE_SKILL", { enumerable: true, get: function () { return tim_mcp_smoke_js_2.TIM_MCP_SMOKE_SKILL; } });
var tim_new_project_js_2 = require("./tim-new-project.js");
Object.defineProperty(exports, "TIM_NEW_PROJECT_SKILL", { enumerable: true, get: function () { return tim_new_project_js_2.TIM_NEW_PROJECT_SKILL; } });
exports.ALL_TIM_SKILLS = [
    tim_handoff_js_1.TIM_HANDOFF_SKILL,
    tim_explain_js_1.TIM_EXPLAIN_SKILL,
    tim_using_js_1.TIM_USING_SKILL,
    tim_remember_js_1.TIM_REMEMBER_SKILL,
    tim_session_start_js_1.TIM_SESSION_START_SKILL,
    tim_hmem_import_audit_js_1.TIM_HMEM_IMPORT_AUDIT_SKILL,
    tim_release_beta_js_1.TIM_RELEASE_BETA_SKILL,
    tim_project_curate_js_1.TIM_PROJECT_CURATE_SKILL,
    tim_sync_triage_js_1.TIM_SYNC_TRIAGE_SKILL,
    tim_secret_audit_js_1.TIM_SECRET_AUDIT_SKILL,
    tim_mcp_smoke_js_1.TIM_MCP_SMOKE_SKILL,
    tim_new_project_js_1.TIM_NEW_PROJECT_SKILL,
];
function getSkill(name) {
    return exports.ALL_TIM_SKILLS.find(s => s.name === name);
}
function listSkills() {
    return [...exports.ALL_TIM_SKILLS];
}
//# sourceMappingURL=index.js.map