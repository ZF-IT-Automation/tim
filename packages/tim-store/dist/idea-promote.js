"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyIdeaPromote = applyIdeaPromote;
const metadata_coerce_js_1 = require("./metadata-coerce.js");
function applyIdeaPromote(metadata, nowIso = new Date().toISOString()) {
    const idea = metadata.idea;
    if (idea !== undefined && !(0, metadata_coerce_js_1.isIdeaMarker)(idea)) {
        if (idea === 'planned' || idea === true) {
            return { metadata, didPromote: false, error: 'Invalid idea marker for promote' };
        }
        return { metadata, didPromote: false };
    }
    if (!(0, metadata_coerce_js_1.isIdeaMarker)(idea)) {
        return { metadata, didPromote: false };
    }
    const ideaObj = idea;
    if (ideaObj.status !== 'planned') {
        return { metadata, didPromote: false };
    }
    if ((0, metadata_coerce_js_1.isTaskMarker)(metadata.task)) {
        return { metadata, didPromote: false, error: 'Cannot promote: entry is already a task' };
    }
    const next = { ...metadata };
    delete next.idea;
    const priorityFromIdea = typeof ideaObj.priority === 'string' ? ideaObj.priority : undefined;
    const priorityFromMeta = typeof metadata.priority === 'string' ? metadata.priority : undefined;
    const task = {
        status: 'todo',
        history: [{ status: 'todo', at: nowIso }],
    };
    if (priorityFromIdea)
        task.priority = priorityFromIdea;
    else if (priorityFromMeta)
        task.priority = priorityFromMeta;
    next.task = task;
    next.type = 'task';
    const prevProv = typeof metadata.provenance === 'object' && metadata.provenance !== null && !Array.isArray(metadata.provenance)
        ? metadata.provenance
        : {};
    next.provenance = { ...prevProv, promoted_from_idea_at: nowIso };
    return { metadata: next, didPromote: true };
}
//# sourceMappingURL=idea-promote.js.map