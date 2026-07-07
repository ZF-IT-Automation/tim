"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HUMAN_SECTIONS = exports.HUMAN_ROOT_LABEL = void 0;
exports.ensureHumanProfile = ensureHumanProfile;
exports.getHumanProfileSummary = getHumanProfileSummary;
exports.HUMAN_ROOT_LABEL = 'H0000';
exports.HUMAN_SECTIONS = [
    'Identity',
    'Skills',
    'Preferences',
    'Context',
];
/** Ensure human profile root (H0000) and standard sections exist. */
async function ensureHumanProfile(store) {
    let root = await store.read(exports.HUMAN_ROOT_LABEL);
    if (!root) {
        root = await store.write('Structured knowledge about the human user.', {
            title: exports.HUMAN_ROOT_LABEL,
            metadata: { kind: 'human', type: 'human-root', label: exports.HUMAN_ROOT_LABEL },
            tags: ['#human'],
        });
    }
    const sections = [];
    for (const name of exports.HUMAN_SECTIONS) {
        const existing = (await store.getChildren(root.id)).find(c => c.title === name);
        if (existing) {
            sections.push(existing);
            continue;
        }
        const section = await store.write(name, {
            parentId: root.id,
            title: name,
            metadata: { kind: 'human', section: name.toLowerCase() },
            tags: ['#human'],
        });
        sections.push(section);
    }
    return { root, sections };
}
async function getHumanProfileSummary(store) {
    const profile = await ensureHumanProfile(store);
    const lines = [`${profile.root.title} (${exports.HUMAN_ROOT_LABEL})`];
    for (const section of profile.sections) {
        const children = await store.getChildren(section.id);
        lines.push(`  ${section.title}: ${children.length} entries`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=user.js.map