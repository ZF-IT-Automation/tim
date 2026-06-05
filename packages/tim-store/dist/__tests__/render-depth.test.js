"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const project_output_js_1 = require("../project-output.js");
function makeProject() {
    return {
        id: "P1",
        metadata: { label: "P1", kind: "project" },
        title: "P1 — Test",
        content: "Test project",
        tags: [],
        createdAt: "2026-06-01T00:00:00Z",
    };
}
(0, vitest_1.describe)("renderDepthLoad / renderDepthRead", () => {
    (0, vitest_1.it)("load mode: renderDepthLoad=0 skips, renderDepthRead=0 shows", () => {
        const project = makeProject();
        const sectionA = {
            id: "sec-a", parentId: "P1", title: "Always Shows",
            metadata: { order: 0 },
            tags: [], content: "", createdAt: "",
        };
        const sectionB = {
            id: "sec-b", parentId: "P1", title: "Load Only",
            metadata: { order: 1, renderDepthLoad: 2, renderDepthRead: 0 },
            tags: [], content: "", createdAt: "",
        };
        const sectionC = {
            id: "sec-c", parentId: "P1", title: "Read Only",
            metadata: { order: 2, renderDepthLoad: 0, renderDepthRead: 2 },
            tags: [], content: "", createdAt: "",
        };
        const result = { project, children: [sectionA, sectionB, sectionC], truncated: false };
        // Load: sectionA shows, sectionB shows, sectionC skipped (renderDepthLoad=0)
        const loadOut = (0, project_output_js_1.formatProjectOutput)(result, 50, undefined, "load");
        (0, vitest_1.expect)(loadOut).toContain("Always Shows");
        (0, vitest_1.expect)(loadOut).toContain("Load Only");
        (0, vitest_1.expect)(loadOut).not.toContain("Read Only");
        // Read: sectionA shows, sectionB skipped (renderDepthRead=0), sectionC shows
        const readOut = (0, project_output_js_1.formatProjectOutput)(result, 50, undefined, "read");
        (0, vitest_1.expect)(readOut).toContain("Always Shows");
        (0, vitest_1.expect)(readOut).not.toContain("Load Only");
        (0, vitest_1.expect)(readOut).toContain("Read Only");
    });
    (0, vitest_1.it)("no renderMode: falls back to legacy render_depth", () => {
        const project = makeProject();
        const section = {
            id: "sec", parentId: "P1", title: "Legacy",
            metadata: { order: 0, render_depth: 0 },
            tags: [], content: "", createdAt: "",
        };
        const result = { project, children: [section], truncated: false };
        // No renderMode, legacy render_depth=0 → skipped
        const out = (0, project_output_js_1.formatProjectOutput)(result, 50);
        (0, vitest_1.expect)(out).not.toContain("Legacy");
    });
    (0, vitest_1.it)("renderMode-specific overrides legacy render_depth", () => {
        const project = makeProject();
        const section = {
            id: "sec", parentId: "P1", title: "Specific Wins",
            metadata: { order: 0, render_depth: 3, renderDepthLoad: 0 },
            tags: [], content: "", createdAt: "",
        };
        const result = { project, children: [section], truncated: false };
        // Load: renderDepthLoad=0 wins → skipped (not legacy render_depth=3)
        const out = (0, project_output_js_1.formatProjectOutput)(result, 50, undefined, "load");
        (0, vitest_1.expect)(out).not.toContain("Specific Wins");
        // Read: no renderDepthRead set, falls back to render_depth=3 → shows
        const readOut = (0, project_output_js_1.formatProjectOutput)(result, 50, undefined, "read");
        (0, vitest_1.expect)(readOut).toContain("Specific Wins");
    });
});
//# sourceMappingURL=render-depth.test.js.map