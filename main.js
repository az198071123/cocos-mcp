'use strict';

// After editing this file or scene-script.js, reload the extension so Creator re-requires it:
//   editor_eval: const p = Editor.Project.path + '/extensions/cocos-mcp';
//                setTimeout(async () => { Editor.Package.disable(p); await new Promise(r => setTimeout(r, 800)); Editor.Package.enable(p); }, 300);
//                return 'scheduled';   // deferred so this reply goes out before the server dies
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// One editor per port: a second Creator instance needs its own, or it loses the race for 1314.
// Precedence: COCOS_MCP_PORT env > a `.port` file next to this one (gitignored) > 1314.
function resolvePort() {
    let raw = process.env.COCOS_MCP_PORT;
    let from = 'COCOS_MCP_PORT';
    if (!raw) {
        from = '.port';
        try { raw = fs.readFileSync(path.join(__dirname, '.port'), 'utf8').trim(); } catch (e) { raw = ''; }
    }
    if (!raw) return 1314;
    const n = Number(raw);
    // Falling back to 1314 on a typo reinstates the very collision .port exists to prevent,
    // and the loser of that race ends up with no server at all.
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`[cocos-mcp] ${from} is "${raw}", which is not a port number`);
    }
    return n;
}
const PORT = resolvePort();
const MAX_CHARS = 20000;
const REQUEST_TIMEOUT_MS = 30000;

// Every editor call goes through here. Some requests neither resolve nor reject: a native modal
// (the "save changes?" prompt when switching assets) blocks the scene channel, and that dialog is
// outside the web contents, so it cannot be seen or screenshotted from here. Without a timeout the
// await never returns, every later call queues behind it, and the server just looks dead. This
// cannot rescue the editor — the request is still hanging inside it — but it turns an infinite
// hang into a message that says where to look.
function request(pkg, method, ...args) {
    let timer = null;
    return Promise.race([
        Promise.resolve(Editor.Message.request(pkg, method, ...args)).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
                `${pkg}:${method} did not answer within ${REQUEST_TIMEOUT_MS}ms. Look at the editor window ` +
                'first — the usual cause is a native dialog waiting to be clicked, which blocks the whole ' +
                'scene channel and is invisible to this server. If there is no dialog, the editor is wedged ' +
                'and only a restart clears it.',
            )), REQUEST_TIMEOUT_MS);
        }),
    ]);
}

let server = null;
const sockets = new Set();

const TOOLS = [
    {
        name: 'editor_request',
        description:
            'Call Editor.Message.request(pkg, method, ...args) in the editor. This is the whole editor API: ' +
            'pkg is "scene" | "asset-db" | "builder" | "project" | "program" | "preview" | ... ' +
            'Examples: ("scene","query-node-tree"), ("scene","query-node",uuid), ' +
            '("scene","set-property",{uuid,path,dump}), ("asset-db","query-assets",{pattern:"db://assets/**/*.prefab"}), ' +
            '("asset-db","query-asset-info","db://assets/x.prefab"). Look signatures up with editor_api first.',
        inputSchema: {
            type: 'object',
            properties: {
                pkg: { type: 'string' },
                method: { type: 'string' },
                args: { type: 'array', description: 'spread as ...args' },
            },
            required: ['pkg', 'method'],
        },
    },
    {
        name: 'editor_eval',
        description:
            'Run async JS in the editor main process; `Editor` and `require` are in scope. Use `return` for the result. ' +
            'For anything the scene graph itself must answer, use scene_eval instead.',
        inputSchema: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
        },
    },
    {
        name: 'scene_eval',
        description:
            'Run async JS inside the scene process; `cc` and `Editor` are in scope and the live scene graph is ' +
            'walkable (e.g. `return cc.director.getScene().children.map(n => n.name)`). Return JSON-serializable data only.',
        inputSchema: {
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
        },
    },
    {
        name: 'set_property',
        description:
            'Write one property and read it straight back, so "it worked" is a measurement rather than a claim. ' +
            'scene set-property reports success for writes that never land — a stale uuid, a mistyped path, a ' +
            'component index that moved — so prefer this over calling it through editor_request. Returns the ' +
            'value actually in the editor afterwards plus three outcomes: changed (it moved), noop (it was ' +
            'already that value), pathMissing (nothing reads at that path, so nothing was written). ' +
            'path takes a component type instead of an index: "__comps__.cc.Widget.right".',
        inputSchema: {
            type: 'object',
            properties: {
                uuid: { type: 'string', description: 'node uuid, from query-node-tree' },
                path: { type: 'string', description: 'e.g. "position.x", "__comps__.2.enabled", "__comps__.cc.Widget.right"' },
                dump: { type: 'object', description: 'the value wrapper, e.g. {"type":"Boolean","value":false}' },
            },
            required: ['uuid', 'path', 'dump'],
        },
    },
    {
        name: 'save',
        description:
            'Save the open scene or prefab, and say what it actually wrote: which file on disk, and the ' +
            'before/after byte, line and sha1 comparison. save-scene on its own tells you neither, and "which ' +
            'file" is not obvious in prefab edit mode. contentChanged false means the save wrote nothing. ' +
            'Benchmark: an untouched prefab saves as a 0-line diff, so any line movement is something real.',
        inputSchema: {
            type: 'object',
            properties: { force: { type: 'boolean', description: 'save even when the editor reports no unsaved changes' } },
        },
    },
    {
        name: 'prefab_create',
        description:
            'Create a new prefab from a described node tree. Nodes are built in the open scene — create-prefab ' +
            'only accepts a live node — then the leftover instance is removed, so the scene ends where it '  +
            'started but marked dirty: undo or close without saving, never save it. The editor does the ' +
            'serialization, so the file format is always right. Properties go through set_property, so a write ' +
            'that does not land fails here instead of being baked into the asset, and the result is verified by ' +
            'instantiating the finished prefab through the engine. Refuses if the url already exists. ' +
            'To add a component to a prefab that already exists, use prefab_add_component instead — it never ' +
            'opens or touches the scene.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'db://assets/.../Name.prefab — the folder is created if missing' },
                tree: {
                    type: 'object',
                    description: 'the root node: { name, components?: ["cc.UITransform","MyScript"], props?: {"__comps__.cc.UITransform.contentSize": {...}}, children?: [ ...same shape ] }. ' +
                        'components take the ccclass name, not a uuid. Note the root node is renamed to the file basename.',
                },
            },
            required: ['url', 'tree'],
        },
    },
    {
        name: 'prefab_add_component',
        description:
            'Add a component to a prefab by editing the asset file, without ever opening it in the editor. ' +
            'Opening a prefab whose nested instances are stale makes the editor resync them and silently drop ' +
            'their CCPropertyOverrideInfo/cc.TargetInfo overrides — thousands of diff lines and a layout that ' +
            'moves. This appends to the end of the file instead, so no existing __id__ is renumbered: about 35 ' +
            'added lines, no deletions, override counts unchanged. The result is verified by instantiating the ' +
            'prefab through the engine, and the file is restored if the component does not come back.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'db://assets/... url, or the prefab uuid' },
                type: { type: 'string', description: 'engine type ("cc.BlockInputEvents") or a script uuid from its .meta ("a4f2d44d-..."), which is compressed for you' },
                nodeId: { type: 'number', description: '__id__ of the node to attach to; default 1, the root' },
                props: { type: 'object', description: 'serialized property values, e.g. {"duration":0.2,"easing":5}' },
            },
            required: ['target', 'type'],
        },
    },
    {
        name: 'build',
        description:
            'Start a Cocos build. With no options it reuses the settings of the last build task (falling back to ' +
            'the build panel profile), so the output overwrites that same folder. Pass overrides to change just a ' +
            'few fields, e.g. {"debug":true} or {"platform":"web-desktop","outputName":"web-desktop-001"}. ' +
            'Returns immediately with a task id — poll build_status. wait:true blocks until the build finishes, ' +
            'which for this project is around a minute and may exceed the MCP client timeout.',
        inputSchema: {
            type: 'object',
            properties: {
                overrides: { type: 'object', description: 'shallow-merged over the base build options' },
                wait: { type: 'boolean', description: 'block until the build finishes (default false)' },
            },
        },
    },
    {
        name: 'build_status',
        description:
            'Build task state: progress, state, and the message/detailMessage carrying build errors. ' +
            'With no id, lists every task plus whether the builder is free. To cancel: ' +
            'editor_request builder break-task [id].',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'task id from build; omit to list all' } },
        },
    },
    {
        name: 'editor_log',
        description:
            'Tail an editor log. source "project" (default) is temp/logs/project.log, where build warnings and ' +
            'errors surface — build_status only carries the last hook name, so check here after a build. ' +
            '"builder" and "asset-db" are the newest file in those packages\' own log directories, with far more ' +
            'detail when a build fails or an import goes wrong. grep is a case-insensitive regex; stack traces ' +
            'are noisy, so filter rather than raising lines.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', enum: ['project', 'builder', 'asset-db'], description: 'default "project"' },
                lines: { type: 'number', description: 'how many trailing lines (default 80)' },
                grep: { type: 'string', description: 'case-insensitive regex filter, e.g. "warn|error"' },
            },
        },
    },
    {
        name: 'screenshot',
        description:
            'Capture an editor window as a PNG you can actually look at. Defaults to the main editor window ' +
            '(scene view, hierarchy, inspector). Use editor_eval with BrowserWindow.getAllWindows() to find other ids.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: { type: 'number', description: 'omit for the main editor window' },
                width: { type: 'number', description: 'downscale to this width (default 1280)' },
            },
        },
    },
    {
        name: 'preview',
        description:
            'Preview server info: the URL the running game is served on, the preview platform, and how many ' +
            'clients are connected. Driving the game itself is the puppeteer MCP\'s job — open this URL there, ' +
            'then use page.evaluate with cc.director to locate nodes and click the canvas at their screen coords.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'reload',
        description:
            'Reload this extension so edits to main.js or scene-script.js take effect. The server drops for ' +
            'about two seconds and comes back on the same port — just retry your next call. Scene scripts are ' +
            'require-cached, so editing scene-script.js does nothing until you call this.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'asset_info',
        description:
            'Everything about one asset in a single call: size, sub-assets, who references it (resolved to ' +
            'paths and grouped by top-level folder), and what it depends on. Takes a db:// url or a uuid. ' +
            'NOTE ON ghostUsers: the reference index can name assets that do not exist in this checkout — ' +
            'other branches sharing this folder, or deleted files. A zero userCount therefore does NOT mean ' +
            'the asset is unused; check the other branches before deleting anything.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'db://assets/... url, or a uuid' },
                limit: { type: 'number', description: 'how many user paths to list (default 20)' },
            },
            required: ['target'],
        },
    },
    {
        name: 'editor_api',
        description:
            'Grep the bundled @cocos/creator-types .d.ts for a message name or type, returning its TypeScript ' +
            'signature. Call this before guessing arguments for editor_request.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'e.g. "set-property" or "query-assets"' },
            },
            required: ['query'],
        },
    },
];

function eachTypeFile(accept, visit) {
    const seen = new Set();
    const rooted = (root, prefix) => {
        const rec = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) rec(full);
                else if (e.name.endsWith('.d.ts') && accept(e.name) && !seen.has(full)) {
                    seen.add(full);
                    visit(prefix + full.slice(root.length + 1), full);
                }
            }
        };
        rec(root);
    };
    // Bundled types cover ~51 scene messages; the installed packages declare 200+, so scan both.
    rooted(path.join(Editor.Project.path, 'node_modules/@cocos/creator-types/editor/packages'), '');
    for (const pkg of Editor.Package.getPackages()) rooted(path.join(pkg.path, '@types'), pkg.name + '/@types/');
}

function grepTypes(query) {
    const seen = new Set();
    const collect = (accept, limit) => {
        const hits = [];
        eachTypeFile(accept, (label, file) => {
            if (hits.length >= limit) return;
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (hits.length >= limit || !line.includes(query)) return;
                const snippet = lines.slice(i, i + 12).join('\n');
                const key = snippet.slice(0, 100);
                if (seen.has(key)) return;
                seen.add(key);
                hits.push(`--- ${label}:${i + 1}\n${snippet}`);
            });
        });
        return hits;
    };
    // message.d.ts first: those are the callable signatures. Supporting types come after.
    const hits = collect((n) => n === 'message.d.ts', 20).concat(collect((n) => n !== 'message.d.ts', 10));
    return hits.length ? hits.join('\n\n') : `no match for "${query}"`;
}

// add-task returns two different enums depending on shouldWait — decode both so the model isn't reading a bare int.
const ADD_RESULT = { 0: 'BUSY (a build is already running)', 1: 'SUCCESS (queued)', 2: 'PARAM_ERROR' };
const EXIT_CODE = { 32: 'PARAM_ERROR', 34: 'BUILD_FAILED', 36: 'BUILD_SUCCESS', 37: 'BUILD_BUSY', 50: 'UNKNOWN_ERROR' };

async function buildOptions(overrides) {
    const o = Object.assign({}, overrides);
    // check-and-complete-options needs a platform to look its config up; everything else it fills in.
    if (!o.platform) {
        const info = await request('builder', 'query-tasks-info', { type: 'build' }).catch(() => null);
        // The list runs newest-first, but aborted tasks sink to the end — sort by id (a
        // creation timestamp) rather than trusting the order. .pop() picked the OLDEST build.
        const last = info && newestTask((info.list || []).filter((t) => t.options && t.options.platform));
        if (last) o.platform = last.options.platform;
        else {
            const profile = path.join(Editor.Project.path, 'profiles/v2/packages/builder.json');
            o.platform = JSON.parse(fs.readFileSync(profile, 'utf8')).common.platform;
        }
    }
    try {
        // The builder validates and completes far better than merging a previous task's options by hand:
        // it fills every required field, follows taskName to outputName, and swaps platform-specific packages.
        return await request('builder', 'check-and-complete-options', o);
    } catch (e) {
        const cfg = await request('builder', 'query-platform-config').catch(() => null);
        const valid = cfg && cfg.order ? ` Valid platforms: ${cfg.order.join(', ')}.` : '';
        // Without this, add-task happily queues bad options and only says "参数校验失败" once the task fails,
        // with an empty detailMessage — so validate up front instead.
        throw new Error(`builder rejected these build options: ${e.message}.${valid}`);
    }
}

// Task ids are creation timestamps; the list's own order is not dependable.
function newestTask(tasks) {
    return tasks.slice().sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

function taskBrief(t) {
    return {
        id: t.id,
        state: t.state,
        progress: t.progress,
        message: t.message,
        detailMessage: t.detailMessage,
        time: t.time,
        platform: t.options && t.options.platform,
        dest: t.options && `${t.options.buildPath}/${t.options.outputName}`,
    };
}

// Editor logs reach megabytes; read only the tail rather than pulling the whole file into memory.
function tailFile(file, maxBytes) {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - (maxBytes || 512 * 1024));
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // drop the partial first line
    } finally {
        fs.closeSync(fd);
    }
}

function newestFileIn(dir) {
    const files = fs.readdirSync(dir)
        .map((n) => path.join(dir, n))
        .filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
    if (!files.length) throw new Error(`no log files in ${dir}`);
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// builder/ and asset-db/ keep timestamped log files in a directory; project.log is a single file.
const LOG_SOURCES = {
    project: (tmp) => path.join(tmp, 'logs/project.log'),
    builder: (tmp) => newestFileIn(path.join(tmp, 'builder/log')),
    'asset-db': (tmp) => newestFileIn(path.join(tmp, 'asset-db/log')),
};

// A dump node wraps its payload as { value, type }, and nesting alternates between the two.
// Walk both shapes so callers write the path they see in the inspector ("position.x"),
// not the serialization ("position.value.x").
function readByPath(dump, path) {
    let cur = dump;
    for (const key of path.split('.')) {
        if (cur === null || typeof cur !== 'object') return undefined;
        if (!(key in cur) && cur.value && typeof cur.value === 'object') cur = cur.value;
        if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
        cur = cur[key];
    }
    // Report the value, not the wrapper: a wrapper carries editor-side metadata that is
    // noise in a before/after diff.
    return cur && typeof cur === 'object' && 'value' in cur ? cur.value : cur;
}

// Allow __comps__.cc.Widget.right instead of __comps__.3.right. Getting the index means
// querying the node first, and an index that shifts (a component added or removed) writes
// to the wrong component with no error at all.
function resolveComponentPath(dump, path) {
    const PREFIX = '__comps__.';
    if (!path.startsWith(PREFIX)) return { path };
    const rest = path.slice(PREFIX.length);
    if (/^\d+\./.test(rest)) return { path };
    const types = ((dump && dump.__comps__) || []).map((c) => c.type || c.cid);
    // Component types are namespaced ("cc.Widget"), so the type/property boundary is not the
    // first dot — match against the types actually on this node, longest first so that a type
    // which is a prefix of another does not win.
    const type = types.filter(Boolean).sort((x, y) => y.length - x.length).find((t) => rest.startsWith(t + '.'));
    if (!type) {
        throw new Error(`cannot resolve "${rest}" to a component on this node — it has: ${types.join(', ') || '(none)'}`);
    }
    const prop = rest.slice(type.length + 1);
    const hits = [];
    types.forEach((t, i) => { if (t === type) hits.push(i); });
    if (hits.length > 1) {
        throw new Error(`${hits.length} components of type ${type} on this node; use an explicit index: ${hits.map((i) => `${PREFIX}${i}.${prop}`).join(' | ')}`);
    }
    return { path: `${PREFIX}${hits[0]}.${prop}`, resolvedFrom: path };
}

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// A prefab stores a script component's type as Cocos's compressed uuid, which is why grepping a
// prefab for the uuid out of a .meta finds nothing. Keep the first five characters, then recode
// the remaining 27 hex digits three at a time: each 12 bits become two base64 characters.
function compressUuid(uuid) {
    const hex = String(uuid).replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a uuid: ${uuid}`);
    let out = hex.slice(0, 5);
    for (let i = 5; i < 32; i += 3) {
        const n = parseInt(hex.slice(i, i + 3), 16);
        out += BASE64_KEYS[n >> 6] + BASE64_KEYS[n & 63];
    }
    return out;
}

// Every component in a prefab carries a cc.CompPrefabInfo whose fileId must be unique in the file.
function randomFileId() {
    let s = '';
    for (let i = 0; i < 22; i += 1) s += BASE64_KEYS[crypto.randomInt(64)];
    return s;
}

// Saving says nothing about which file it wrote or how much moved. Measuring both sides turns
// "saved" into a number to compare against the diff you expected.
function fingerprint(file) {
    if (!file) return null;
    try {
        const buf = fs.readFileSync(file);
        let lines = 0;
        for (const b of buf) if (b === 0x0a) lines += 1;
        return { bytes: buf.length, lines, sha1: crypto.createHash('sha1').update(buf).digest('hex') };
    } catch (e) {
        return null;
    }
}

function countTypes(doc, type) {
    return doc.filter((e) => e && e.__type__ === type).length;
}

async function callTool(name, a) {
    switch (name) {
        case 'editor_request':
            return await request(a.pkg, a.method, ...(a.args || []));
        case 'editor_eval':
            return await new Function('Editor', 'require', `return (async () => { ${a.code} })()`)(Editor, require);
        case 'scene_eval': {
            const runScene = (method, args) =>
                request('scene', 'execute-scene-script', { name: 'cocos-mcp', method, args });
            let out;
            try {
                out = await runScene('run', [a.code]);
            } catch (e) {
                // Engine objects are circular, and returning one is the most natural first attempt.
                if (/circular structure/i.test(e.message || '')) {
                    // Guidance first: the raw circular error dumps a long property chain that buries anything after it.
                    throw new Error(
                        'the return value crosses a process boundary and must be JSON-serializable. Node, Component ' +
                        'and Scene are circular — return plain data instead, e.g. `node.name` or ' +
                        `\`node.children.map(n => n.name)\`.\n\nOriginal: ${String(e.message).slice(0, 200)}`,
                    );
                }
                throw e;
            }
            // undefined is ambiguous: code with no return, or a scene script the editor never registered.
            // Only the second is a problem, and it is otherwise completely silent.
            if (out === undefined && (await runScene('ping', []).catch(() => null)) !== 'pong') {
                throw new Error(
                    'the scene script is not registered, so every scene_eval silently returns undefined. ' +
                    'Call the reload tool; if that does not help, reopen the scene in the editor.',
                );
            }
            return out;
        }
        case 'set_property': {
            const beforeDump = await request('scene', 'query-node', a.uuid);
            // A stale uuid (every one in a prefab goes stale when it reloads) returns nothing
            // here, and set-property on it is a silent no-op. Fail before writing instead.
            if (!beforeDump) throw new Error(`no such node: ${a.uuid} — uuids go stale when a prefab reloads; re-query the tree`);
            const { path, resolvedFrom } = resolveComponentPath(beforeDump, a.path);
            const before = readByPath(beforeDump, path);
            const returned = await request('scene', 'set-property', { uuid: a.uuid, path, dump: a.dump });
            const after = readByPath(await request('scene', 'query-node', a.uuid), path);
            const changed = JSON.stringify(before) !== JSON.stringify(after);
            // Not writing and writing-the-same-value are both "unchanged" but mean opposite
            // things: only one of them needs fixing. Split them on whether the path reads at all.
            const pathMissing = before === undefined && after === undefined;
            // Snapshot only on a real change: it is also what marks the scene dirty, so an
            // unconditional one leaves a * in the title for a write that did nothing.
            if (changed) await request('scene', 'snapshot');
            return {
                path,
                resolvedFrom,
                before,
                after,
                changed,
                noop: !changed && !pathMissing,
                pathMissing,
                setPropertyReturned: returned,
                note: changed
                    ? 'editor memory only — not saved. Widget/sizeMode on the same node, and instance overrides in any outer prefab, can still win at runtime.'
                    : (pathMissing
                        ? `nothing reads at ${path}, so nothing was written — check the path with editor_request scene query-node ${a.uuid}`
                        : 'the value was already this; nothing changed and the scene was not marked dirty'),
            };
        }
        case 'save': {
            const mode = await request('scene', 'query-scene-mode').catch(() => null);
            const openUuid = await request('scene', 'query-current-scene').catch(() => null);
            const info = openUuid ? await request('asset-db', 'query-asset-info', openUuid).catch(() => null) : null;
            const file = info && info.file;
            const dirtyBefore = await request('scene', 'query-dirty');
            if (!dirtyBefore && !a.force) {
                return { saved: false, mode, asset: info && info.url, file, note: 'the editor reports no unsaved changes' };
            }
            const before = fingerprint(file);
            await request('scene', 'save-scene');
            const dirtyAfter = await request('scene', 'query-dirty');
            const after = fingerprint(file);
            // Equal byte counts do not mean equal content, so compare the hash rather than the size.
            const contentChanged = before && after ? before.sha1 !== after.sha1 : null;
            return {
                saved: !dirtyAfter,
                mode,
                asset: info && info.url,
                file,
                editorDirty: !!dirtyAfter,
                fileDelta: before && after
                    ? { contentChanged, bytesBefore: before.bytes, bytesAfter: after.bytes, linesBefore: before.lines, linesAfter: after.lines, deltaLines: after.lines - before.lines }
                    : null,
                note: !file
                    ? 'saved, but the open asset could not be resolved to a file, so nothing was measured — find it before diffing'
                    : (contentChanged
                        ? `wrote ${file} — diff it now. An untouched prefab saves as a 0-line diff, so every changed line is something that was really written.`
                        : 'the file on disk is byte-identical to before; this save wrote nothing'),
            };
        }
        case 'prefab_create': {
            if (!a.url || !/^db:\/\/assets\//.test(a.url)) throw new Error('url must be a db://assets/... path ending in .prefab');
            if (await request('asset-db', 'query-asset-info', a.url).catch(() => null)) {
                throw new Error(`${a.url} already exists — delete it first, or pick another name`);
            }
            const dirtyBefore = await request('scene', 'query-dirty');
            const created = [];   // scene nodes to tear down, deepest first
            let assetUuid = null;
            try {
                // Nodes are built in the open scene because create-prefab only takes a live node.
                // Nothing here is ever saved: the scene is a workbench, and step 5 clears it.
                const build = async (spec, parent) => {
                    if (!spec || !spec.name) throw new Error('every node needs a name');
                    const uuid = await request('scene', 'create-node', parent ? { name: spec.name, parent } : { name: spec.name });
                    created.unshift(uuid);
                    for (const type of spec.components || []) {
                        // component is the ccclass name, not a uuid — a script uses its class name.
                        await request('scene', 'create-component', { uuid, component: type });
                    }
                    for (const [path, dump] of Object.entries(spec.props || {})) {
                        // Through set_property so every write is read back; a silent miss here would
                        // be baked into the asset and only noticed at runtime.
                        const r = await callTool('set_property', { uuid, path, dump });
                        if (r.pathMissing) throw new Error(`${spec.name}: nothing reads at ${path}, so it was not set`);
                    }
                    for (const child of spec.children || []) await build(child, uuid);
                    return uuid;
                };
                const rootUuid = await build(a.tree, undefined);
                assetUuid = await request('scene', 'create-prefab', rootUuid, a.url);
                if (!assetUuid) throw new Error('create-prefab returned nothing; the asset was not written');
            } catch (e) {
                for (const uuid of created) await request('scene', 'remove-node', { uuid }).catch(() => {});
                if (assetUuid) await request('asset-db', 'delete-asset', a.url).catch(() => {});
                throw e;
            }
            // create-prefab destroys the node it was given and drops in a fresh instance with a new
            // uuid, so the ids collected above are stale. Find the instance by the asset it points
            // at rather than by name: the node is also renamed to the file's basename.
            const flatten = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => flatten(c, out)); return out; };
            const instance = flatten(await request('scene', 'query-node-tree'))
                .find((n) => n.prefab && n.prefab.assetUuid === assetUuid);
            if (instance) await request('scene', 'remove-node', { uuid: instance.uuid }).catch(() => {});
            const info = await request('asset-db', 'query-asset-info', a.url).catch(() => null);
            let engineTree = null;
            try {
                engineTree = await callTool('scene_eval', {
                    code: `const asset = await new Promise((res, rej) => cc.assetManager.loadAny([{ uuid: ${JSON.stringify(assetUuid)}, type: cc.Prefab }], (e, r) => e ? rej(e) : res(r)));
                           const n = cc.instantiate(asset);
                           const walk = (x) => ({ name: x.name, components: x.components.map((c) => c.constructor.name), children: x.children.map(walk) });
                           const out = walk(n);
                           n.destroy();
                           return out;`,
                });
            } catch (e) {
                engineTree = { error: String((e && e.message) || e) };
            }
            return {
                asset: a.url,
                uuid: assetUuid,
                file: info && info.file,
                // The engine's own view of what was written — the only check that catches a
                // component whose script never resolved, which is otherwise completely silent.
                engineTree,
                sceneNodeRemoved: !!instance,
                dirtyBefore: !!dirtyBefore,
                note: 'the prefab and its .meta are on disk. The scene was used as a workbench and is now marked dirty even though its content is back where it started — undo or close without saving; do not save it.'
                    + (dirtyBefore ? ' NOTE: the scene already had unsaved changes before this ran, so undo carefully.' : ''),
            };
        }
        case 'prefab_add_component': {
            const info = await request('asset-db', 'query-asset-info', a.target);
            if (!info) throw new Error(`no such asset: ${a.target}`);
            if (info.importer !== 'prefab') throw new Error(`${info.url} is a ${info.importer}, not a prefab`);
            // The point of editing the file is to never open the prefab: opening a prefab whose
            // nested instances are stale makes the editor resync them and drop their property
            // overrides. If it is already open, its in-memory copy wins on the next save and would
            // silently discard this write, so refuse instead of racing it.
            const openUuid = await request('scene', 'query-current-scene').catch(() => null);
            if (openUuid && openUuid === info.uuid) {
                throw new Error(`${info.url} is open in the editor — close it first, or the editor's copy will overwrite this`);
            }
            const original = fs.readFileSync(info.file, 'utf8');
            const doc = JSON.parse(original);
            const nodeId = a.nodeId === undefined ? 1 : a.nodeId;
            const node = doc[nodeId];
            if (!node || node.__type__ !== 'cc.Node') throw new Error(`__id__ ${nodeId} is not a cc.Node in ${info.url}`);
            const type = /^[0-9a-fA-F]{8}-/.test(a.type) ? compressUuid(a.type) : a.type;
            const existing = (node._components || []).map((r) => (doc[r.__id__] || {}).__type__);
            if (existing.includes(type)) throw new Error(`${node._name} already has ${a.type} (${type})`);

            const beforeCounts = {
                CCPropertyOverrideInfo: countTypes(doc, 'CCPropertyOverrideInfo'),
                'cc.TargetInfo': countTypes(doc, 'cc.TargetInfo'),
                entries: doc.length,
            };
            const used = new Set(doc.filter((e) => e && e.fileId).map((e) => e.fileId));
            let fileId = randomFileId();
            while (used.has(fileId)) fileId = randomFileId();

            // Appending keeps every existing __id__ where it is. Inserting anywhere else renumbers
            // the rest of the file, which is most of what makes an editor-written diff unreadable.
            const compId = doc.length;
            doc.push(Object.assign(
                { __type__: type, _name: '', _objFlags: 0, __editorExtras__: {}, node: { __id__: nodeId }, _enabled: true, __prefab: { __id__: compId + 1 } },
                a.props || {},
                { _id: '' },
            ));
            doc.push({ __type__: 'cc.CompPrefabInfo', fileId });
            node._components = (node._components || []).concat([{ __id__: compId }]);

            // Cocos serializes prefabs as JSON.stringify(doc, null, 2) with no trailing newline.
            // Matching it byte for byte is what keeps the diff to the lines actually added; any
            // other formatting reflows the whole file and buries the change.
            await request('asset-db', 'save-asset', info.url, JSON.stringify(doc, null, 2));

            const expected = node._components.length;
            let verified = null;
            let components = null;
            let failure = null;
            try {
                // The engine's own deserializer is the only witness that matters: a component whose
                // script fails to resolve simply does not appear, with nothing logged.
                const out = await callTool('scene_eval', {
                    code: `const asset = await new Promise((res, rej) => cc.assetManager.loadAny([{ uuid: ${JSON.stringify(info.uuid)}, type: cc.Prefab }], (e, r) => e ? rej(e) : res(r)));
                           const n = cc.instantiate(asset);
                           const out = { components: n.components.map((c) => c.constructor.name), children: n.children.length };
                           n.destroy();
                           return out;`,
                });
                components = out && out.components;
                verified = nodeId === 1 ? Array.isArray(components) && components.length === expected : Array.isArray(components);
            } catch (e) {
                failure = String((e && e.message) || e);
            }
            if (!verified) {
                await request('asset-db', 'save-asset', info.url, original);
                throw new Error(
                    `the prefab did not come back with the component, so the file was restored. ${failure || `expected ${expected} components on the root, the engine built ${components ? components.length : 'none'}: ${JSON.stringify(components)}`}`,
                );
            }
            const afterCounts = {
                CCPropertyOverrideInfo: countTypes(doc, 'CCPropertyOverrideInfo'),
                'cc.TargetInfo': countTypes(doc, 'cc.TargetInfo'),
                entries: doc.length,
            };
            return {
                asset: info.url,
                file: info.file,
                node: node._name,
                type,
                typeFrom: type === a.type ? undefined : a.type,
                fileId,
                verified: true,
                rootComponents: nodeId === 1 ? components : undefined,
                verifiedScope: nodeId === 1 ? 'root component list' : 'prefab deserializes; per-node check only covers the root',
                overridesBefore: beforeCounts,
                overridesAfter: afterCounts,
                overridesLost: beforeCounts.CCPropertyOverrideInfo - afterCounts.CCPropertyOverrideInfo,
                note: 'written straight to the file and re-imported; the prefab was never opened, so no nested instances were resynced. git diff it — the change should be about 35 lines with no deletions.',
            };
        }
        case 'build': {
            const options = await buildOptions(a.overrides);
            const before = await request('builder', 'query-tasks-info', { type: 'build' });
            const known = new Set((before.list || []).map((t) => t.id));
            // Raw, not request(): with wait:true this blocks for the whole build, which is the point.
            const code = await Editor.Message.request('builder', 'add-task', options, !!a.wait);
            const after = await request('builder', 'query-tasks-info', { type: 'build' });
            const task = (after.list || []).filter((t) => !known.has(t.id)).pop() || (after.list || []).pop();
            // add-task returns SUCCESS even when another build is already running; the new task just sits
            // there with "build task is busy". info.free stays true in that state, so it cannot be used —
            // look at the other tasks' states instead.
            const ahead = (before.list || [])
                .filter((t) => t.state === 'processing' || t.state === 'waiting')
                .map((t) => t.id);
            return {
                result: a.wait ? EXIT_CODE[code] || code : ADD_RESULT[code] || code,
                platform: options.platform,
                dest: `${options.buildPath}/${options.outputName}`,
                queuedBehind: ahead.length ? ahead : undefined,
                task: task ? taskBrief(task) : null,
            };
        }
        case 'build_status': {
            if (a.id) return taskBrief(await request('builder', 'query-task', a.id));
            const info = await request('builder', 'query-tasks-info', { type: 'build' });
            // info.queue is an id->task record of every task, not a pending queue — `free` is the busy flag.
            return { free: info.free, tasks: (info.list || []).map(taskBrief) };
        }
        case 'editor_log': {
            const pick = LOG_SOURCES[a.source || 'project'];
            if (!pick) throw new Error(`unknown log source "${a.source}" — use one of: ${Object.keys(LOG_SOURCES).join(', ')}`);
            const file = pick(Editor.Project.tmpDir);
            // A trailing newline yields an empty last element; lines:1 would return just that blank.
            const all = tailFile(file).replace(/\n$/, '').split('\n');
            const lines = a.grep ? all.filter((l) => new RegExp(a.grep, 'i').test(l)) : all;
            return `# ${file.replace(Editor.Project.path, '')}\n${lines.slice(-(a.lines || 80)).join('\n')}`;
        }
        case 'screenshot': {
            const { BrowserWindow } = require('electron');
            const wins = BrowserWindow.getAllWindows();
            const win = a.windowId
                ? wins.find((w) => w.id === a.windowId)
                : wins.find((w) => w.getTitle().includes('Cocos Creator')) || wins[0];
            if (!win) throw new Error(`no such window; available: ${wins.map((w) => `${w.id}:${w.getTitle()}`).join(', ')}`);
            let img = await win.webContents.capturePage();
            const width = a.width || 1280;
            if (img.getSize().width > width) img = img.resize({ width });
            return { __png: img.toPNG().toString('base64') };
        }
        case 'preview':
            return {
                url: await request('preview', 'query-preview-url'),
                ip: await request('preview', 'get-preview-ip'),
                platform: await Editor.Profile.getConfig('preview', 'preview.current.platform', 'default'),
                connections: await request('preview', 'query-connect-num'),
            };
        case 'reload': {
            // Deferred: disabling this package kills the HTTP server, so the reply has to go out first.
            setTimeout(async () => {
                try {
                    Editor.Package.disable(__dirname);
                    await new Promise((r) => setTimeout(r, 800));
                    Editor.Package.enable(__dirname);
                } catch (e) {
                    console.error('[cocos-mcp] reload failed', e);
                }
            }, 300);
            return 'reload scheduled — back on this port in ~2s';
        }
        case 'asset_info': {
            const info = await request('asset-db', 'query-asset-info', a.target);
            if (!info) throw new Error(`no such asset: ${a.target}`);
            const [users, deps, meta] = await Promise.all([
                request('asset-db', 'query-asset-users', info.uuid).catch(() => []),
                request('asset-db', 'query-asset-dependencies', info.uuid).catch(() => []),
                request('asset-db', 'query-asset-meta', info.uuid).catch(() => null),
            ]);
            const resolved = await Promise.all(
                (users || []).map((u) => request('asset-db', 'query-asset-info', u).catch(() => null)),
            );
            const paths = resolved.filter(Boolean).map((ui) => ui.source);
            const ghosts = resolved.length - paths.length;
            const byFolder = {};
            for (const src of paths) {
                const m = src.match(/^db:\/\/assets\/([^/]+)/);
                const k = m ? m[1] : '?';
                byFolder[k] = (byFolder[k] || 0) + 1;
            }
            let bytes = null;
            try {
                const st = fs.statSync(info.file);
                // A directory's own inode size (a few hundred bytes) says nothing about what is inside it.
                if (st.isFile()) bytes = st.size;
            } catch (e) { /* sub-assets have no file of their own */ }
            // Sub-assets (uuid@sub) come back with an empty source, so name them after their parent.
            let source = info.source;
            if (!source && String(a.target).includes('@')) {
                const [parentUuid, sub] = String(a.target).split('@');
                const parent = await request('asset-db', 'query-asset-info', parentUuid).catch(() => null);
                if (parent) source = `${parent.source}@${sub}`;
            }
            const subMetas = (meta && meta.subMetas) || {};
            return {
                source,
                uuid: info.uuid,
                importer: info.importer,
                bytes,
                subAssets: Object.entries(subMetas).map(([id, m]) => `${info.uuid}@${id} (${m.importer})`),
                userCount: paths.length,
                ghostUsers: ghosts,
                usersByFolder: byFolder,
                users: paths.slice(0, a.limit || 20),
                dependencyCount: (deps || []).length,
                dependencies: (deps || []).slice(0, a.limit || 20),
            };
        }
        case 'editor_api':
            return grepTypes(a.query);
    }
    throw new Error(`unknown tool: ${name}`);
}

function clip(value) {
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch (e) {
        text = String(value);
    }
    // An empty reply reads as a broken tool; say so explicitly.
    if (text === undefined) text = 'undefined';
    if (text === '') text = '(empty string)';
    return text.length > MAX_CHARS
        ? `${text.slice(0, MAX_CHARS)}\n...[truncated: showing ${MAX_CHARS} of ${text.length} chars. ` +
          'Do not retry as-is — aggregate inside editor_eval and return only the fields you need.]'
        : text;
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const RESOURCES = [
    { uri: 'cocos://project', name: 'Project', description: 'Project path, name, preview URL and platform', mimeType: 'application/json' },
    { uri: 'cocos://scene/active', name: 'Active scene', description: 'Open scene: node tree with each node\'s components', mimeType: 'application/json' },
    { uri: 'cocos://build/latest', name: 'Latest build', description: 'Most recent build task: state, progress, destination', mimeType: 'application/json' },
    { uri: 'cocos://log/recent', name: 'Recent log', description: 'Last 60 lines of the editor log', mimeType: 'text/plain' },
];

async function readResource(uri) {
    switch (uri) {
        case 'cocos://project':
            return {
                name: Editor.Project.name,
                path: Editor.Project.path,
                uuid: Editor.Project.uuid,
                previewUrl: await request('preview', 'query-preview-url'),
                platform: await Editor.Profile.getConfig('preview', 'preview.current.platform', 'default'),
            };
        case 'cocos://scene/active':
            return await callTool('scene_eval', {
                code: "const s = cc.director.getScene(); if (!s) return null;" +
                      "const walk = (n, d = 0) => [{ d, name: n.name, comps: n.components.map(c => c.constructor.name) }, ...n.children.flatMap(c => walk(c, d + 1))];" +
                      "return { scene: s.name, nodes: walk(s) };",
            });
        case 'cocos://build/latest': {
            const info = await request('builder', 'query-tasks-info', { type: 'build' });
            const last = newestTask(info.list || []);
            return { free: info.free, latest: last ? taskBrief(last) : null };
        }
        case 'cocos://log/recent':
            return await callTool('editor_log', { lines: 60 });
    }
    throw Object.assign(new Error(`unknown resource: ${uri}`), { code: -32602 });
}

async function handle(msg) {
    const { method, params } = msg;
    if (method === 'initialize') {
        return {
            // Echoing an unknown version would claim support we do not have.
            protocolVersion: SUPPORTED_PROTOCOLS.includes(params && params.protocolVersion)
                ? params.protocolVersion
                : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'cocos-mcp', version: '1.0.0' },
        };
    }
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'resources/list') return { resources: RESOURCES };
    if (method === 'resources/read') {
        const text = clip(await readResource(params.uri));
        const res = RESOURCES.find((r) => r.uri === params.uri);
        return { contents: [{ uri: params.uri, mimeType: res ? res.mimeType : 'text/plain', text }] };
    }
    if (method === 'tools/call') {
        // Tool failures are results with isError, not JSON-RPC errors — the model needs to read them.
        try {
            const out = await callTool(params.name, params.arguments || {});
            // Images bypass clip(), which would truncate the base64 into garbage.
            if (out && out.__png) return { content: [{ type: 'image', data: out.__png, mimeType: 'image/png' }] };
            return { content: [{ type: 'text', text: clip(out) }] };
        } catch (e) {
            return { content: [{ type: 'text', text: String((e && e.stack) || e) }], isError: true };
        }
    }
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

const MAX_BODY = 4 * 1024 * 1024;

function onRequest(req, res) {
    // A browser always sends Origin; an MCP client never does. Without this check, any page the
    // developer visits while Creator is open can POST here as a CORS simple request — text/plain
    // needs no preflight, and editor_eval is new Function with require in scope. The attacker
    // cannot read the reply, but the code has already run. Binding to 127.0.0.1 does not help:
    // the request originates from this machine.
    if (req.headers.origin) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('origin not allowed\n');
        return;
    }
    // Spec: an invalid or unsupported MCP-Protocol-Version MUST get 400. A missing header is
    // fine — the spec says to assume 2025-03-26 in that case.
    const version = req.headers['mcp-protocol-version'];
    if (version && !SUPPORTED_PROTOCOLS.includes(version)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`unsupported MCP-Protocol-Version "${version}" — supported: ${SUPPORTED_PROTOCOLS.join(', ')}\n`);
        return;
    }
    // GET would open an SSE stream; the spec allows 405 when the server does not offer one.
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    // Refuse on the declared length first: rejecting mid-upload reaches the client as a
    // connection error instead of the 413. The streaming check below still covers a chunked
    // request or a lying Content-Length.
    if (Number(req.headers['content-length']) > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('body too large\n');
        return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
        if (rejected) return;
        size += c.length;
        if (size > MAX_BODY) {
            rejected = true;
            // Reply and stop buffering, but do not destroy the socket: resetting it mid-upload
            // surfaces on the client as ECONNRESET instead of the 413 we just sent.
            res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
            res.end('body too large\n');
            return;
        }
        chunks.push(c);
    });
    req.on('end', async () => {
        if (rejected) return;
        // Decode once, at the end: `body += chunk` stringifies each Buffer on its own, so a
        // multibyte character split across TCP segments decodes as replacement characters.
        let msg;
        try {
            msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`invalid JSON: ${e.message}\n`);
            return;
        }
        const batch = Array.isArray(msg) ? msg : [msg];
        const out = [];
        for (const m of batch) {
            if (m.id === undefined) continue; // notification: no reply
            try {
                out.push({ jsonrpc: '2.0', id: m.id, result: await handle(m) });
            } catch (e) {
                out.push({
                    jsonrpc: '2.0',
                    id: m.id,
                    error: { code: e.code || -32000, message: String((e && e.message) || e) },
                });
            }
        }
        if (!out.length) {
            res.writeHead(202).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    });
}

exports.load = function () {
    server = http.createServer(onRequest);
    // Keep-alive sockets outlive close(); track them so reloading the extension frees the port.
    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    server.on('error', (e) => console.error('[cocos-mcp]', e.message));
    server.listen(PORT, '127.0.0.1', () => console.log(`[cocos-mcp] http://127.0.0.1:${PORT}/mcp`));
};

exports.unload = function () {
    sockets.forEach((s) => s.destroy());
    sockets.clear();
    if (server) server.close();
    server = null;
};

exports.methods = {};
