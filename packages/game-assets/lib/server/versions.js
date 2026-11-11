/** `name-v2`, `name_v2.1`, `v3`, `name-v2-pilot`: the name, the version number, and a variant suffix. */
const VERSIONED = /^(.*?)[-_. ]?v(\d+(?:\.\d+)*)((?:[-_. ].+)?)$/i;
export function versionOf(segment) {
    const match = VERSIONED.exec(segment);
    if (!match)
        return undefined;
    // `nav`, `v8engine` and the like are words, not versions.
    if (match[1] && /[A-Za-z0-9]$/.test(match[1]) && !/[-_. ]v\d/i.test(segment))
        return undefined;
    return { name: match[1].replace(/[-_. ]+$/, ''), version: match[2], label: `v${match[2]}${match[3]}` };
}
const compareVersions = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++)
        if ((left[i] ?? 0) !== (right[i] ?? 0))
            return (left[i] ?? 0) - (right[i] ?? 0);
    return 0;
};
/**
 * Groups images by the outermost versioned folder on their path and sets `family` and `version` on those whose folder has
 * at least one sibling version. Families list their versions oldest first.
 */
export function groupVersions(assets) {
    const families = new Map();
    for (const asset of assets) {
        const parts = asset.path.split('/');
        for (let i = 0; i < parts.length - 1; i++) {
            const versioned = versionOf(parts[i]);
            if (!versioned)
                continue;
            const dir = parts.slice(0, i).join('/'), id = `${dir}/${versioned.name}`;
            let family = families.get(id);
            if (!family)
                families.set(id, family = { dir, name: versioned.name, slots: new Map() });
            let slot = family.slots.get(versioned.label);
            if (!slot)
                family.slots.set(versioned.label, slot = { label: versioned.label, version: versioned.version, path: parts.slice(0, i + 1).join('/'), members: [] });
            slot.members.push(asset);
            break;
        }
    }
    const result = [];
    for (const [id, family] of families) {
        if (family.slots.size < 2)
            continue;
        const slots = [...family.slots.values()].sort((a, b) => compareVersions(a.version, b.version) || a.label.localeCompare(b.label));
        for (const slot of slots)
            for (const asset of slot.members) {
                asset.family = id;
                asset.version = slot.label;
            }
        result.push({ id, dir: family.dir, name: family.name, versions: slots.map(slot => ({
                label: slot.label, path: slot.path, total: slot.members.length,
                used: slot.members.filter(asset => asset.usage === 'used').length, maybe: slot.members.filter(asset => asset.usage === 'maybe').length,
                bytes: slot.members.reduce((sum, asset) => sum + asset.size, 0),
            })) });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
}
