// Offline check: stub Editor, run the extension, speak MCP at it.
// Default to a port nothing else claims; a live editor on 1314/1315 would otherwise answer for us.
process.env.COCOS_MCP_PORT = process.env.COCOS_MCP_PORT || '19314';
const PORT = process.env.COCOS_MCP_PORT;
const assert = require('assert');
let addTaskArgs = null;
const pkgCalls = [];
const FAKE_PNG = Buffer.from('fake png bytes');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-'));
// The extension lives at <project>/extensions/<name>, so the project root is two levels up.
const PROJECT = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(tmp, 'logs'));
fs.writeFileSync(path.join(tmp, 'logs/project.log'), 'a info 1\nb warn 2\nc warn 3\nd info 4\n');
require('module')._load = ((orig) => function (req, ...rest) {
    if (req === 'electron') {
        return { BrowserWindow: { getAllWindows: () => [{
            id: 1, getTitle: () => 'x - Cocos Creator 3.8.8',
            webContents: { capturePage: async () => ({ getSize: () => ({ width: 100 }), resize: () => { throw new Error('should not resize'); }, toPNG: () => FAKE_PNG }) },
        }] } };
    }
    return orig.call(this, req, ...rest);
})(require('module')._load);
global.Editor = {
    Project: { path: PROJECT, tmpDir: tmp, name: 'test-project', uuid: 'u1' },
    Package: { getPackages: () => [], disable: (p) => pkgCalls.push(['disable', p]), enable: (p) => pkgCalls.push(['enable', p]) },
    Profile: { getConfig: async () => 'browser' },
    Message: {
        async request(pkg, method, ...args) {
            if (pkg === 'scene' && method === 'execute-scene-script') return { echoed: args[0] };
            if (pkg === 'builder' && method === 'query-tasks-info') {
                return {
                    free: true,
                    queue: {},
                    list: [{
                        id: 'T1', state: 'success', progress: 1, message: 'build success in 58 s!', time: 'x',
                        options: { platform: 'web-mobile', buildPath: 'project://build', outputName: 'web-mobile-001' },
                    }],
                };
            }
            if (pkg === 'builder' && method === 'add-task') { addTaskArgs = args; return args[1] ? 36 : 1; }
            if (pkg === 'asset-db' && method === 'query-asset-info') {
                const t = args[0];
                if (t === 'db://assets/x.png' || t === 'U-IMG') {
                    return { source: 'db://assets/x.png', uuid: 'U-IMG', importer: 'image', file: __filename };
                }
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
    assert.equal(list.result.tools.length, 11);

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
    assert.equal(addTaskArgs[0].platform, 'web-mobile', 'base options not inherited');
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
    assert.equal(log.result.content[0].text, 'b warn 2\nc warn 3', 'grep+tail wrong: ' + log.result.content[0].text);

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
    assert.equal(aij.dependencies, 2);
    assert.ok(aij.bytes > 0, 'bytes should come from the file on disk');

    const miss = await (await post({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'asset_info', arguments: { target: 'db://nope' } } })).json();
    assert.equal(miss.result.isError, true, 'a missing asset must surface as an error');

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
    assert.equal(again.result.tools.length, 11, 'reload leaked the port');
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
        assert.equal(viaEnv.result.tools.length, 11, 'COCOS_MCP_PORT must outrank .port');
        fresh.unload();
    } finally {
        if (hadPort === null) fs.unlinkSync(portFile);
        else fs.writeFileSync(portFile, hadPort);
    }

    console.log('all checks passed');
    process.exit(0);
})();
