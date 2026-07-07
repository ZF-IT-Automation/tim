"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_TIM_SKILLS = exports.TIM_SESSION_START_SKILL = exports.TIM_REMEMBER_SKILL = exports.TIM_USING_SKILL = exports.TIM_EXPLAIN_SKILL = exports.TIM_HANDOFF_SKILL = void 0;
exports.getSkill = getSkill;
exports.listSkills = listSkills;
const tim_handoff_js_1 = require("./tim-handoff.js");
const tim_explain_js_1 = require("./tim-explain.js");
const tim_using_js_1 = require("./tim-using.js");
const tim_remember_js_1 = require("./tim-remember.js");
const tim_session_start_js_1 = require("./tim-session-start.js");
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
exports.ALL_TIM_SKILLS = [
    tim_handoff_js_1.TIM_HANDOFF_SKILL,
    tim_explain_js_1.TIM_EXPLAIN_SKILL,
    tim_using_js_1.TIM_USING_SKILL,
    tim_remember_js_1.TIM_REMEMBER_SKILL,
    tim_session_start_js_1.TIM_SESSION_START_SKILL,
];
function getSkill(name) {
    return exports.ALL_TIM_SKILLS.find(s => s.name === name);
}
function listSkills() {
    return [...exports.ALL_TIM_SKILLS];
}
//# sourceMappingURL=index.js.map