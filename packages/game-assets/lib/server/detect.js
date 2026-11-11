/** Whether a workspace is a game project, told from the engine it declares. Reads a handful of small files at its root. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const LIMIT = 1024 * 1024;
const text = async (file) => {
    try {
        const data = await readFile(file);
        return data.length > LIMIT ? '' : data.toString('utf8');
    }
    catch {
        return '';
    }
};
/** npm packages that make a project a 2D game; a name ending in `/` matches the whole scope. */
const NPM = [
    ['phaser', 'Phaser'], ['phaser-ce', 'Phaser'], ['pixi.js', 'PixiJS'], ['@pixi/', 'PixiJS'], ['kaboom', 'Kaboom'], ['kaplay', 'KAPLAY'], ['excalibur', 'Excalibur'],
    ['melonjs', 'melonJS'], ['littlejsengine', 'LittleJS'], ['kontra', 'Kontra'], ['playcanvas', 'PlayCanvas'], ['@babylonjs/core', 'Babylon.js'], ['babylonjs', 'Babylon.js'],
    ['@rpgjs/', 'RPGJS'], ['cocos2d-html5', 'Cocos2d'], ['crafty', 'Crafty'], ['ct-js', 'ct.js'],
];
/** The engine an npm manifest depends on, or `Cocos Creator` for a manifest that engine wrote. */
export function engineOfPackage(manifest) {
    let parsed;
    try {
        parsed = JSON.parse(manifest);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object')
        return undefined;
    const names = new Set();
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const group = parsed[key];
        if (group && typeof group === 'object')
            for (const name of Object.keys(group))
                names.add(name);
    }
    for (const [name, engine] of NPM)
        if (name.endsWith('/') ? [...names].some(entry => entry.startsWith(name)) : names.has(name))
            return engine;
    return parsed.creator && typeof parsed.creator === 'object' ? 'Cocos Creator' : undefined;
}
/** Text manifests of other ecosystems, and what in them names an engine. */
const MANIFESTS = [
    ['Cargo.toml', [[/^\s*bevy\b/m, 'Bevy'], [/^\s*macroquad\b/m, 'macroquad'], [/^\s*ggez\b/m, 'ggez'], [/^\s*fyrox\b/m, 'Fyrox']]],
    ['go.mod', [[/hajimehoshi\/ebiten/, 'Ebitengine']]],
    ['requirements.txt', [[/^\s*pygame(?:-ce)?\b/mi, 'pygame'], [/^\s*arcade\b/mi, 'Arcade'], [/^\s*pyglet\b/mi, 'pyglet']]],
    ['pyproject.toml', [[/["']pygame(?:-ce)?\b/i, 'pygame'], [/["']arcade\b/i, 'Arcade'], [/["']pyglet\b/i, 'pyglet']]],
    ['build.gradle', [[/com\.badlogicgames\.gdx/, 'libGDX']]],
    ['build.gradle.kts', [[/com\.badlogicgames\.gdx/, 'libGDX']]],
    ['main.lua', [[/\blove\.(?:load|draw|update|graphics)\b/, 'LÖVE']]],
];
/**
 * The game engine a folder is a project of, or undefined. Looks at the folder itself and, for npm manifests, at the
 * folders directly inside it, where a repository often keeps its game beside a server or tools.
 */
export async function detectEngine(root) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    if (files.has('project.godot'))
        return 'Godot';
    if (files.has('game.project'))
        return 'Defold';
    for (const name of files) {
        if (name.endsWith('.uproject'))
            return 'Unreal Engine';
        if (name.endsWith('.yyp'))
            return 'GameMaker';
        if (/\.(?:rpgproject|rmmzproject|rvproj2|rxproj)$/.test(name))
            return 'RPG Maker';
    }
    if (entries.some(entry => entry.isDirectory() && entry.name === 'ProjectSettings') && await text(join(root, 'ProjectSettings', 'ProjectVersion.txt')))
        return 'Unity';
    if (files.has('package.json')) {
        const engine = engineOfPackage(await text(join(root, 'package.json')));
        if (engine)
            return engine;
    }
    for (const [name, signs] of MANIFESTS) {
        if (!files.has(name))
            continue;
        const content = await text(join(root, name));
        for (const [sign, engine] of signs)
            if (sign.test(content))
                return engine;
    }
    for (const name of [...files].filter(file => file.endsWith('.csproj')).slice(0, 3))
        if (/MonoGame\./.test(await text(join(root, name))))
            return 'MonoGame';
    const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').slice(0, 40);
    for (const folder of folders) {
        const engine = engineOfPackage(await text(join(root, folder.name, 'package.json')));
        if (engine)
            return engine;
    }
    return undefined;
}
