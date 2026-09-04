// Offline check: stub Editor, run the extension, speak MCP at it.
// Default to a port nothing else claims; a live editor on 1314/1315 would otherwise answer for us.
process.env.COCOS_MCP_PORT = process.env.COCOS_MCP_PORT || '19314';
const PORT = process.env.COCOS_MCP_PORT;
const assert = require('assert');
let addTaskArgs = null;
const pkgCalls = [];
let scenePingAlive = true;
let builderBusy = false;
const FAKE_PNG = Buffer.from('fake png bytes');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-'));
// The extension lives at <project>/extensions/<name>, so the project root is two levels up.
const PROJECT = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(tmp, 'logs'));
fs.writeFileSync(path.join(tmp, 'logs/project.log'), 'a info 1\nb warn 2\nc warn 3\nd info 4\n');
for (const [dir, files] of [['builder/log', [['old.log', 'stale builder line\n'], ['new.log', 'BUILDER TAIL\n']]],
                            ['asset-db/log', [['db.log', 'ASSETDB TAIL\n']]]]) {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    for (const [n, body] of files) fs.writeFileSync(path.join(tmp, dir, n), body);
}
// make 'new.log' unambiguously newest, and give it a body larger than the tail window
fs.writeFileSync(path.join(tmp, 'builder/log/new.log'), 'X'.repeat(700 * 1024) + '\nBUILDER TAIL\n');
fs.utimesSync(path.join(tmp, 'builder/log/old.log'), new Date(0), new Date(0));
require('module')._load = ((orig) => function (req, ...rest) {
    if (req === 'electron') {
        return { BrowserWindow: { getAllWindows: () => [{
            id: 1, getTitle: () => 'x - Cocos Creator 3.8.8',
            webContents: { capturePage: async () => ({ getSize: () => ({ width: 100 }), resize: () => { throw new Error('should not resize'); }, toPNG: () => FAKE_PNG }) },
        }] } };
    }
    return orig.call(this, req, ...rest);
})(require('module')._load);
// A prefab on disk that save-asset really rewrites, so an append that corrupts the file, loses an
// override, or fails to roll back is caught rather than assumed.
const PREFAB_FILE = path.join(tmp, 'Panel.prefab');
const PREFAB_URL = 'db://assets/op6/Panel.prefab';
const PREFAB_UUID = 'P-PREFAB';
// How many components the fake engine reports back; the tool compares this against the file.
let instantiateComponents = null;
let sceneMode = 'general';
let sceneDirty = true;
let openSceneUuid = 'OTHER-SCENE';
const resetPrefab = () => {
    const doc = [
        { __type__: 'cc.Prefab', _name: 'Panel', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'Panel', _components: [{ __id__: 2 }], _prefab: { __id__: 4 } },
        { __type__: 'cc.UITransform', node: { __id__: 1 }, __prefab: { __id__: 3 } },
        { __type__: 'cc.CompPrefabInfo', fileId: 'existingFileId00000000' },
        { __type__: 'cc.PrefabInfo', fileId: 'rootFileId000000000000' },
        { __type__: 'CCPropertyOverrideInfo', propertyPath: ['_lpos'] },
        { __type__: 'cc.TargetInfo', localID: ['abc'] },
    ];
    // Cocos's own formatting: two-space indent, no trailing newline.
    fs.writeFileSync(PREFAB_FILE, JSON.stringify(doc, null, 2));
    instantiateComponents = ['UITransform', 'MoveInOnEnable'];
};
resetPrefab();

// A live node the set-property stub actually mutates. A stub that echoed the request back
// would let a set_property that never writes anything pass every assertion below.
let sceneNode = null;
let snapshots = 0;
const resetSceneNode = () => {
    snapshots = 0;
    sceneNode = {
        position: { type: 'cc.Vec3', value: { x: 0, y: 0, z: 0 } },
        __comps__: [
            { type: 'cc.UITransform', value: { contentSize: { type: 'cc.Size', value: { width: 100, height: 50 } } } },
            { type: 'cc.Widget', value: { right: { type: 'Number', value: 10 } } },
            { type: 'MyComp', value: { speed: { type: 'Number', value: 1 } } },
            { type: 'MyComp', value: { speed: { type: 'Number', value: 2 } } },
        ],
    };
};
resetSceneNode();

global.Editor = {
    Project: { path: PROJECT, tmpDir: tmp, name: 'test-project', uuid: 'u1' },
    Package: { getPackages: () => [], disable: (p) => pkgCalls.push(['disable', p]), enable: (p) => pkgCalls.push(['enable', p]) },
    Profile: { getConfig: async () => 'browser' },
    Message: {
        async request(pkg, method, ...args) {
            if (pkg === 'scene' && method === 'execute-scene-script') {
                const { method: m, args: inner } = args[0];
                if (m === 'ping') return scenePingAlive ? 'pong' : undefined;
                if (inner[0] === 'CIRCULAR') throw new Error('Converting circular structure to JSON');
                if (inner[0] === 'NORETURN') return undefined;
                // Stands in for the engine deserializing the prefab; a component whose script fails
                // to resolve is simply absent from this list, which is what the tool checks for.
                if (String(inner[0]).includes('cc.instantiate')) {
                    if (instantiateComponents === 'THROW') throw new Error('Cannot read property of undefined');
                    return { components: instantiateComponents, children: 0 };
                }
                return { echoed: args[0] };
            }
            if (pkg === 'scene' && method === 'query-dirty') return sceneDirty;
            if (pkg === 'scene' && method === 'query-scene-mode') return sceneMode;
            if (pkg === 'scene' && method === 'query-current-scene') return openSceneUuid;
            if (pkg === 'scene' && method === 'save-scene') { sceneDirty = false; return 'saved'; }
            if (pkg === 'asset-db' && method === 'save-asset') {
                fs.writeFileSync(PREFAB_FILE, args[1]);
                return { url: PREFAB_URL, uuid: PREFAB_UUID, file: PREFAB_FILE, importer: 'prefab' };
            }
            if (pkg === 'scene' && method === 'query-node') return args[0] === 'N1' ? sceneNode : null;
            if (pkg === 'scene' && method === 'snapshot') { snapshots += 1; return undefined; }
            if (pkg === 'scene' && method === 'set-property') {
                const { path, dump } = args[0];
                // Deliberately returns true even when it writes nothing — that is the real
                // editor's most dangerous behaviour, and the reason set_property reads back.
                const parts = path.split('.');
                let cur = sceneNode;
                for (const k of parts.slice(0, -1)) {
                    if (cur && !(k in cur) && cur.value) cur = cur.value;
                    if (!cur || !(k in cur)) return true;
                    cur = cur[k];
                }
                const last = parts[parts.length - 1];
                if (cur && !(last in cur) && cur.value) cur = cur.value;
                if (!cur || !(last in cur)) return true;
                if (cur[last] && typeof cur[last] === 'object' && 'value' in cur[last]) cur[last].value = dump.value;
                else cur[last] = dump.value;
                return true;
            }
            if (pkg === 'builder' && method === 'query-tasks-info') {
                return {
                    free: true, // deliberately true even when busy — mirrors the real builder
                    queue: {},
                    list: (builderBusy ? [{ id: '3000', state: 'processing', progress: 0.2, message: '', options: { platform: 'web-mobile', buildPath: 'project://build', outputName: 'x' } }] : []).concat([
                        // deliberately oldest-first, with a different platform, to catch .pop()
                        { id: '1000', state: 'success', progress: 1, message: 'older', time: 'x',
                          options: { platform: 'web-desktop', buildPath: 'project://build', outputName: 'old' } },
                        { id: '2000', state: 'success', progress: 1, message: 'build success in 58 s!', time: 'x',
                          options: { platform: 'web-mobile', buildPath: 'project://build', outputName: 'web-mobile-001' } },
                    ]),
                };
            }
            if (pkg === 'builder' && method === 'check-and-complete-options') {
                const o = args[0];
                if (!['web-mobile', 'web-desktop'].includes(o.platform)) throw new Error('Cannot convert undefined or null to object');
                return Object.assign({ buildPath: 'project://build', outputName: 'web-mobile-001', taskName: 'web-mobile-001' }, o);
            }
            if (pkg === 'builder' && method === 'query-platform-config') return { order: ['web-mobile', 'web-desktop'] };
            if (pkg === 'builder' && method === 'add-task') { addTaskArgs = args; return args[1] ? 36 : 1; }
            if (pkg === 'asset-db' && method === 'query-asset-info') {
                const t = args[0];
                if (t === PREFAB_URL || t === PREFAB_UUID) {
                    return { url: PREFAB_URL, uuid: PREFAB_UUID, file: PREFAB_FILE, importer: 'prefab', source: PREFAB_URL };
                }
                if (t === 'OTHER-SCENE') return { url: 'db://assets/a.scene', uuid: 'OTHER-SCENE', file: PREFAB_FILE, importer: 'scene' };
                if (t === 'db://assets/x.png' || t === 'U-IMG') {
                    return { source: 'db://assets/x.png', uuid: 'U-IMG', importer: 'image', file: __filename };
                }
                if (t === 'db://assets/dir') return { source: 'db://assets/dir', uuid: 'U-DIR', importer: 'directory', file: __dirname };
                if (t === 'U-IMG@f9941') return { source: '', uuid: 'U-IMG@f9941', importer: 'sprite-frame', file: '' };
                if (t === 'U-A') return { source: 'db://assets/common/a.prefab', uuid: 'U-A', importer: 'prefab' };
                if (t === 'U-B') return { source: 'db://assets/op6/b.prefab', uuid: 'U-B', importer: 'prefab' };
                return null; // U-GHOST: in the index, not in this checkout
            }
            if (pkg === 'asset-db' && method === 'query-asset-users') return ['U-A', 'U-B', 'U-GHOST', 'U-GHOST2'];
            if (pkg === 'asset-db' && method === 'query-asset-dependencies') return ['D1', 'D2'];
            if (pkg === 'asset-db' && method === 'query-asset-meta') return { subMetas: { f9941: { importer: 'sprite-frame' }, '6c48a': { importer: 'texture' } } };
            if (pkg === 'preview' && method === 'query-preview-url') return 'http://127.0.0.1:7456';
            if (pkg === 'preview' && method === 'get-preview-ip') return '127.0.0.1';
            if (pkg === 'preview' && method === 'query-connect-num') return 0;
            if (pkg === 'builder' && method === 'query-task') {
                return { id: args[0], state: 'success', progress: 1, message: 'ok', options: { platform: 'web-mobile', buildPath: 'project://build', outputName: 'web-mobile-001' } };
            }
            return { pkg, method, args };
        },
    },
};
const ext = require('./main.js');

const post = (body) =>
    fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

// Abort loudly if the port is taken — otherwise load() fails silently and every assertion below
// runs against whatever server does answer (a real editor, in the worst case).
async function assertPortFree() {
    await new Promise((resolve, reject) => {
        const probe = require('net').createServer();
        probe.once('error', (e) => reject(new Error(`port ${PORT} is in use (${e.code}) — set COCOS_MCP_PORT to a free one`)));
        probe.once('listening', () => probe.close(resolve));
        probe.listen(PORT, '127.0.0.1');
    });
}

(async () => {
    await assertPortFree();
    ext.load();
    await new Promise((r) => setTimeout(r, 200));

    const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(init.result.serverInfo.name, 'cocos-mcp');

    const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notif.status, 202, 'notification must get 202, no body');

    const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.equal(list.result.tools.length, 14);

    // set_property: the four outcomes, against a stub whose set-property always claims success
    {
        let id = 900;
        const set = async (args) => {
            const r = await (await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'set_property', arguments: args } })).json();
            return r.result.isError ? { isError: true, text: r.result.content[0].text } : JSON.parse(r.result.content[0].text);
        };
        resetSceneNode();

        const moved = await set({ uuid: 'N1', path: 'position.x', dump: { type: 'Number', value: 42 } });
        assert.equal(moved.changed, true);
        assert.equal(moved.before, 0);
        assert.equal(moved.after, 42);
        assert.equal(snapshots, 1, 'a real change must snapshot, which is what marks the scene dirty');

        const again = await set({ uuid: 'N1', path: 'position.x', dump: { type: 'Number', value: 42 } });
        assert.equal(again.noop, true, 'writing the value it already has is a noop, not a change');
        assert.equal(again.changed, false);
        assert.equal(snapshots, 1, 'a noop must not snapshot — that would dirty the scene for nothing');

        // The whole point: set-property returned true and nothing was written.
        const bad = await set({ uuid: 'N1', path: '__comps__.1.nosuchprop', dump: { type: 'Number', value: 1 } });
        assert.equal(bad.setPropertyReturned, true, 'the stub lies, like the editor does');
        assert.equal(bad.pathMissing, true, 'the readback must catch what the return value hid');
        assert.equal(bad.changed, false);
        assert.equal(snapshots, 1);

        // component type instead of index
        const byType = await set({ uuid: 'N1', path: '__comps__.cc.Widget.right', dump: { type: 'Number', value: 7 } });
        assert.equal(byType.path, '__comps__.1.right');
        assert.equal(byType.resolvedFrom, '__comps__.cc.Widget.right');
        assert.equal(byType.after, 7);

        const dupe = await set({ uuid: 'N1', path: '__comps__.MyComp.speed', dump: { type: 'Number', value: 9 } });
        assert.match(dupe.text, /2 components of type MyComp.*__comps__\.2\.speed/s, 'duplicate types must list the indexes, not guess');

        const absent = await set({ uuid: 'N1', path: '__comps__.cc.Sprite.enabled', dump: { type: 'Boolean', value: false } });
        assert.match(absent.text, /cannot resolve "cc\.Sprite\.enabled".*cc\.UITransform/s);

        const stale = await set({ uuid: 'GONE', path: 'position.x', dump: { type: 'Number', value: 1 } });
        assert.match(stale.text, /no such node: GONE/);
    }

    // save: which file, and how much of it actually moved
    {
        let id = 940;
        const save = async (args = {}) => {
            const r = await (await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'save', arguments: args } })).json();
            return r.result.isError ? { isError: true, text: r.result.content[0].text } : JSON.parse(r.result.content[0].text);
        };
        resetPrefab();
        sceneDirty = true;
        const saved = await save();
        assert.equal(saved.saved, true);
        assert.equal(saved.file, PREFAB_FILE, 'must name the file to diff, not just report success');
        assert.equal(saved.fileDelta.contentChanged, false, 'save-scene wrote nothing here, and that must be visible');

        const clean = await save();
        assert.equal(clean.saved, false, 'a clean editor must not be saved again');
        assert.match(clean.note, /no unsaved changes/);
    }

    // prefab_add_component: append to the file, verify through the engine, roll back if it lies
    {
        let id = 960;
        const add = async (args) => {
            const r = await (await post({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'prefab_add_component', arguments: args } })).json();
            return r.result.isError ? { isError: true, text: r.result.content[0].text } : JSON.parse(r.result.content[0].text);
        };
        resetPrefab();
        const originalText = fs.readFileSync(PREFAB_FILE, 'utf8');

        const ok = await add({ target: PREFAB_URL, type: 'a4f2d44d-f78f-4fcb-bc21-0dc0c1b7e2d8', props: { duration: 0.2, easing: 5 } });
        // The compressed form is what a prefab actually stores; this exact string was read out of
        // a real prefab that the editor wrote, so it pins the algorithm to observed output.
        assert.equal(ok.type, 'a4f2dRN949Py7whDcDBt+LY');
        assert.equal(ok.verified, true);
        assert.equal(ok.overridesLost, 0, 'appending must not cost a single override');
        assert.equal(ok.overridesAfter.CCPropertyOverrideInfo, ok.overridesBefore.CCPropertyOverrideInfo);

        const written = fs.readFileSync(PREFAB_FILE, 'utf8');
        const doc = JSON.parse(written);
        const originalDoc = JSON.parse(originalText);
        // Everything that was already in the file must survive untouched. The one exception is the
        // target node's own _components list, which is the point of the operation. Anything else
        // moving means entries were renumbered, and that is what makes an editor diff unreadable.
        originalDoc.forEach((entry, i) => {
            if (i === 1) return;
            assert.deepEqual(doc[i], entry, `entry ${i} must not change`);
        });
        assert.deepEqual({ ...doc[1], _components: undefined }, { ...originalDoc[1], _components: undefined },
            'the target node must change only in its component list');
        // Cocos writes no trailing newline; adding one would reflow nothing but still dirty the file.
        assert.ok(!written.endsWith('\n'), 'must match Cocos formatting exactly, including the missing final newline');
        assert.equal(doc.length, 9, 'one component plus one CompPrefabInfo');
        assert.deepEqual(doc[1]._components, [{ __id__: 2 }, { __id__: 7 }], 'appended, so no existing __id__ moved');
        assert.equal(doc[7].__prefab.__id__, 8);
        assert.notEqual(doc[8].fileId, doc[3].fileId, 'a colliding fileId would break the prefab');

        const dupe = await add({ target: PREFAB_URL, type: 'a4f2d44d-f78f-4fcb-bc21-0dc0c1b7e2d8' });
        assert.match(dupe.text, /already has/);

        // The rollback path: the engine builds the prefab without the component, so the write is
        // a silent failure and the file must go back exactly as it was.
        resetPrefab();
        const before = fs.readFileSync(PREFAB_FILE, 'utf8');
        instantiateComponents = ['UITransform'];      // the new component did not come back
        const bad = await add({ target: PREFAB_URL, type: 'cc.BlockInputEvents' });
        assert.ok(bad.isError, 'a component the engine cannot build must not be reported as added');
        assert.match(bad.text, /file was restored/);
        assert.equal(fs.readFileSync(PREFAB_FILE, 'utf8'), before, 'the file must be byte-identical after a rollback');

        // Refuses to race the editor over the same asset.
        resetPrefab();
        openSceneUuid = PREFAB_UUID;
        const open = await add({ target: PREFAB_URL, type: 'cc.BlockInputEvents' });
        assert.match(open.text, /open in the editor/);
        openSceneUuid = 'OTHER-SCENE';
    }

    const req = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'editor_request', arguments: { pkg: 'scene', method: 'query-node-tree' } } })).json();
    assert.match(req.result.content[0].text, /query-node-tree/);

    const ev = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'editor_eval', arguments: { code: 'return Editor.Project.path' } } })).json();
    assert.equal(ev.result.content[0].text, PROJECT);

    const se = await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'scene_eval', arguments: { code: 'return 1' } } })).json();
    assert.match(se.result.content[0].text, /echoed/);

    const api = await (await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'editor_api', arguments: { query: 'set-property' } } })).json();
    assert.match(api.result.content[0].text, /scene\/@types\/message\.d\.ts/);

    const bad = await (await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } })).json();
    assert.equal(bad.result.isError, true, 'tool failure is a result, not an rpc error');

    const nom = await (await post({ jsonrpc: '2.0', id: 8, method: 'bogus/method' })).json();
    assert.equal(nom.error.code, -32601);

    // build reuses the last task's options and decodes the right enum for each wait mode
    const b = await (await post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'build', arguments: { overrides: { debug: true } } } })).json();
    const bj = JSON.parse(b.result.content[0].text);
    assert.equal(bj.result, 'SUCCESS (queued)', 'no-wait must decode TaskAddResult, got ' + bj.result);
    assert.equal(bj.dest, 'project://build/web-mobile-001');
    assert.equal(addTaskArgs[0].debug, true, 'overrides not merged');
    assert.equal(addTaskArgs[0].platform, 'web-mobile', 'must inherit the NEWEST task by id, not the first or last in the list');
    assert.equal(addTaskArgs[1], false, 'shouldWait must default to false');

    const bw = await (await post({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'build', arguments: { wait: true } } })).json();
    assert.equal(JSON.parse(bw.result.content[0].text).result, 'BUILD_SUCCESS', 'wait must decode BuildExitCode');

    const st = await (await post({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'build_status', arguments: {} } })).json();
    assert.match(st.result.content[0].text, /"free": true/);

    // screenshot must come back as an image block, never a clipped text block
    const shot = await (await post({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })).json();
    assert.equal(shot.result.content[0].type, 'image');
    assert.equal(shot.result.content[0].mimeType, 'image/png');
    assert.equal(shot.result.content[0].data, FAKE_PNG.toString('base64'), 'base64 must survive intact');

    const log = await (await post({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'editor_log', arguments: { grep: 'warn', lines: 2 } } })).json();
    assert.match(log.result.content[0].text, /b warn 2\nc warn 3$/, 'grep+tail wrong: ' + log.result.content[0].text);

    const pv = await (await post({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'preview', arguments: {} } })).json();
    assert.match(pv.result.content[0].text, /7456/);

    const rl = await (await post({ jsonrpc: '2.0', id: 16, method: 'resources/list' })).json();
    assert.equal(rl.result.resources.length, 4);

    const rr = await (await post({ jsonrpc: '2.0', id: 17, method: 'resources/read', params: { uri: 'cocos://project' } })).json();
    assert.equal(rr.result.contents[0].uri, 'cocos://project');
    assert.match(rr.result.contents[0].text, /test-project/);

    const rbad = await (await post({ jsonrpc: '2.0', id: 18, method: 'resources/read', params: { uri: 'cocos://nope' } })).json();
    assert.equal(rbad.error.code, -32602, 'unknown resource must be an rpc error');

    // initialize must advertise resources, or clients never ask for them
    assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });

    // asset_info must resolve real users, count ghosts separately, and group by folder
    const ai = await (await post({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'asset_info', arguments: { target: 'db://assets/x.png' } } })).json();
    const aij = JSON.parse(ai.result.content[0].text);
    assert.equal(aij.userCount, 2, 'ghosts must not inflate userCount');
    assert.equal(aij.ghostUsers, 2, 'unresolvable users must be reported, not dropped');
    assert.deepEqual(aij.usersByFolder, { common: 1, op6: 1 });
    assert.deepEqual(aij.subAssets, ['U-IMG@f9941 (sprite-frame)', 'U-IMG@6c48a (texture)']);
    assert.equal(aij.dependencyCount, 2);
    assert.deepEqual(aij.dependencies, ['D1', 'D2'], 'the description promises dependencies, not a count');
    assert.ok(aij.bytes > 0, 'bytes should come from the file on disk');

    const miss = await (await post({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'asset_info', arguments: { target: 'db://nope' } } })).json();
    assert.equal(miss.result.isError, true, 'a missing asset must surface as an error');

    // log sources: builder/asset-db resolve to the newest file in their directory
    const lb = await (await post({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'editor_log', arguments: { source: 'builder', lines: 1 } } })).json();
    assert.match(lb.result.content[0].text, /BUILDER TAIL/, 'builder log should read the newest file, got: ' + lb.result.content[0].text.slice(0, 120));
    assert.match(lb.result.content[0].text, /^# .*builder\/log\/new\.log/m, 'output should name the file it read');
    assert.ok(lb.result.content[0].text.length < 5000, 'a 700KB log must be tailed, not returned whole');

    const ld = await (await post({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'editor_log', arguments: { source: 'asset-db', lines: 1 } } })).json();
    assert.match(ld.result.content[0].text, /ASSETDB TAIL/);

    const lbad = await (await post({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'editor_log', arguments: { source: 'nope' } } })).json();
    assert.equal(lbad.result.isError, true);
    assert.match(lbad.result.content[0].text, /project, builder, asset-db/, 'bad source must list the valid ones');

    // an invalid platform must be rejected up front, not queued and left to fail with an empty detailMessage
    const badPlat = await (await post({ jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'build', arguments: { overrides: { platform: 'not-a-platform' } } } })).json();
    assert.equal(badPlat.result.isError, true, 'invalid platform must error, not queue');
    assert.match(badPlat.result.content[0].text, /Valid platforms: web-mobile, web-desktop/, 'error must list valid platforms: ' + badPlat.result.content[0].text);

    // a circular return must explain the process boundary, not just echo the raw TypeError
    const circ = await (await post({ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'scene_eval', arguments: { code: 'CIRCULAR' } } })).json();
    assert.equal(circ.result.isError, true);
    assert.match(circ.result.content[0].text, /JSON-serializable/, 'circular error must say how to fix it');

    // undefined with a live scene script is a legitimate result
    scenePingAlive = true;
    const noret = await (await post({ jsonrpc: '2.0', id: 28, method: 'tools/call', params: { name: 'scene_eval', arguments: { code: 'NORETURN' } } })).json();
    assert.equal(noret.result.isError, undefined, 'plain no-return must not be an error');
    assert.equal(noret.result.content[0].text, 'undefined');

    // undefined with a dead scene script must stop being silent
    scenePingAlive = false;
    const dead = await (await post({ jsonrpc: '2.0', id: 29, method: 'tools/call', params: { name: 'scene_eval', arguments: { code: 'NORETURN' } } })).json();
    assert.equal(dead.result.isError, true, 'unregistered scene script must surface, not return undefined');
    assert.match(dead.result.content[0].text, /not registered/);
    scenePingAlive = true;

    // a build queued behind another must say so — add-task reports SUCCESS either way
    builderBusy = true;
    const qb = await (await post({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'build', arguments: {} } })).json();
    assert.deepEqual(JSON.parse(qb.result.content[0].text).queuedBehind, ['3000'], 'must report what it is queued behind');
    builderBusy = false;
    const qf = await (await post({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'build', arguments: {} } })).json();
    assert.equal(JSON.parse(qf.result.content[0].text).queuedBehind, undefined, 'idle builder must not add noise');

    // a directory's inode size is not its content size — reporting it invites wrong conclusions
    const dir = await (await post({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'asset_info', arguments: { target: 'db://assets/dir' } } })).json();
    assert.equal(JSON.parse(dir.result.content[0].text).bytes, null, 'directory bytes must be null, not the inode size');

    // sub-assets carry no source of their own; name them after the parent
    const sub = await (await post({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'asset_info', arguments: { target: 'U-IMG@f9941' } } })).json();
    const subj = JSON.parse(sub.result.content[0].text);
    assert.equal(subj.source, 'db://assets/x.png@f9941', 'sub-asset source should resolve via parent, got: ' + subj.source);
    assert.equal(subj.bytes, null);

    // SECURITY: a page the developer visits must not reach editor_eval. Browsers always send
    // Origin; text/plain needs no preflight, so without this check the request goes straight through.
    const drive = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'editor_eval', arguments: { code: 'return 1' } } }),
    });
    assert.equal(drive.status, 403, 'a request carrying Origin must be refused');

    // A multibyte character split across TCP segments must survive.
    const cjk = '排資源要用壓縮後大小';
    const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'editor_eval', arguments: { code: `return ${JSON.stringify(cjk)}` } } }), 'utf8');
    const cut = raw.indexOf(Buffer.from(cjk, 'utf8')) + 1; // one byte into the first CJK char
    const split = await new Promise((resolve, reject) => {
        const sock = require('net').createConnection(PORT, '127.0.0.1', () => {
            sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${raw.length}\r\nConnection: close\r\n\r\n`);
            sock.write(raw.subarray(0, cut));
            setTimeout(() => sock.write(raw.subarray(cut)), 30);
        });
        let buf = '';
        sock.on('data', (d) => (buf += d.toString('utf8')));
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
    });
    assert.ok(split.includes(cjk), 'multibyte split across chunks was mangled: ' + split.slice(-160));

    // An oversized body must be refused rather than buffered.
    const big = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(5 * 1024 * 1024),
    }).catch((e) => ({ status: 'connection closed: ' + e.message }));
    assert.equal(big.status, 413, 'oversized body must be rejected, got ' + big.status);

    // Malformed JSON should say so, not return an empty 400.
    const badJson = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.match(await badJson.text(), /invalid JSON/);

    // truncation notice must say how much was cut, and must not leak source-level string concat
    const trunc = await (await post({ jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'editor_eval', arguments: { code: "return 'x'.repeat(25000)" } } })).json();
    const tail = trunc.result.content[0].text.slice(-200);
    assert.match(tail, /truncated: showing 20000 of 25000 chars/, 'wrong truncation numbers: ' + tail);
    assert.ok(!tail.includes('" +'), 'truncation notice leaked a string-concat artifact: ' + tail);

    // initialize must not claim to speak a version it does not implement
    const okVer = await (await post({ jsonrpc: '2.0', id: 93, method: 'initialize', params: { protocolVersion: '2024-11-05' } })).json();
    assert.equal(okVer.result.protocolVersion, '2024-11-05', 'a supported version should be echoed');
    const badVer = await (await post({ jsonrpc: '2.0', id: 94, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json();
    assert.equal(badVer.result.protocolVersion, '2025-06-18', 'an unknown version must not be echoed back');

    // MCP-Protocol-Version: unsupported MUST be 400, supported and absent must both pass
    const verBad = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': 'not-a-version' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 95, method: 'tools/list' }),
    });
    assert.equal(verBad.status, 400, 'an unsupported protocol version must be refused');
    assert.match(await verBad.text(), /unsupported MCP-Protocol-Version/);

    const verOk = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 96, method: 'tools/list' }),
    });
    assert.equal(verOk.status, 200);

    // Absent header must NOT be an error — the spec says assume 2025-03-26
    const verNone = await (await post({ jsonrpc: '2.0', id: 97, method: 'tools/list' })).json();
    assert.ok(verNone.result.tools.length > 0, 'a missing version header must still be served');

    // GET is the SSE stream the spec makes optional; 405 is the allowed answer when absent
    const get = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(get.status, 405);

    // reload must reply BEFORE tearing the server down, then disable/enable this very directory
    const rel = await (await post({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'reload', arguments: {} } })).json();
    assert.match(rel.result.content[0].text, /reload scheduled/);
    assert.deepEqual(pkgCalls, [], 'reload must not touch the package before replying');
    await new Promise((r) => setTimeout(r, 1400));
    assert.deepEqual(pkgCalls.map((c) => c[0]), ['disable', 'enable'], 'reload order wrong: ' + JSON.stringify(pkgCalls));
    assert.equal(pkgCalls[0][1], __dirname, 'reload must target its own directory, got ' + pkgCalls[0][1]);

    // reload must free the port
    ext.unload();
    await new Promise((r) => setTimeout(r, 100));
    ext.load();
    await new Promise((r) => setTimeout(r, 200));
    const again = await (await post({ jsonrpc: '2.0', id: 9, method: 'tools/list' })).json();
    assert.equal(again.result.tools.length, 14, 'reload leaked the port');
    ext.unload();


    // .port is the per-project override; env must still win over it
    // .port may be a real per-project setting — never destroy it.
    const portFile = path.join(__dirname, '.port');
    const hadPort = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : null;
    fs.writeFileSync(portFile, '1399\n');
    try {
        delete require.cache[require.resolve('./main.js')];
        const fresh = require('./main.js');
        fresh.load();
        await new Promise((r) => setTimeout(r, 200));
        const viaEnv = await (await post({ jsonrpc: '2.0', id: 19, method: 'tools/list' })).json();
        assert.equal(viaEnv.result.tools.length, 14, 'COCOS_MCP_PORT must outrank .port');
        fresh.unload();
    } finally {
        if (hadPort === null) fs.unlinkSync(portFile);
        else fs.writeFileSync(portFile, hadPort);
    }

    // a malformed .port must refuse to load — falling back to 1314 is the collision it exists to prevent
    {
        const saved = process.env.COCOS_MCP_PORT;
        delete process.env.COCOS_MCP_PORT;
        fs.writeFileSync(portFile, 'not-a-port\n');
        try {
            delete require.cache[require.resolve('./main.js')];
            assert.throws(() => require('./main.js'), /not a port number/, 'a malformed .port must throw');
        } finally {
            if (hadPort === null) { try { fs.unlinkSync(portFile); } catch (e) { /* already gone */ } }
            else fs.writeFileSync(portFile, hadPort);
            process.env.COCOS_MCP_PORT = saved;
            delete require.cache[require.resolve('./main.js')];
        }
    }

    console.log('all checks passed');
    process.exit(0);
})();
