'use strict';

// After editing this file or scene-script.js, reload the extension so Creator re-requires it:
//   editor_eval: const p = Editor.Project.path + '/extensions/cocos-mcp';
//                setTimeout(async () => { Editor.Package.disable(p); await new Promise(r => setTimeout(r, 800)); Editor.Package.enable(p); }, 300);
//                return 'scheduled';   // deferred so this reply goes out before the server dies
const http = require('http');
const fs = require('fs');
const path = require('path');

// One editor per port: a second Creator instance needs its own, or it loses the race for 1314.
// Precedence: COCOS_MCP_PORT env > a `.port` file next to this one (gitignored) > 1314.
function resolvePort() {
    if (process.env.COCOS_MCP_PORT) return Number(process.env.COCOS_MCP_PORT);
    try { return Number(fs.readFileSync(path.join(__dirname, '.port'), 'utf8').trim()) || 0; } catch (e) { return 0; }
}
const PORT = resolvePort() || 1314;
const MAX_CHARS = 20000;

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
            'Tail the editor log (temp/logs/project.log). This is where build warnings and errors actually land — ' +
            'build_status only carries the last hook name, so check here after a build. grep is a case-insensitive ' +
            'regex; stack traces are noisy, so filter rather than raising lines.',
        inputSchema: {
            type: 'object',
            properties: {
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
    const info = await Editor.Message.request('builder', 'query-tasks-info', { type: 'build' });
    const last = (info.list || []).filter((t) => t.options).pop();
    let base = last && last.options;
    if (!base) {
        const profile = path.join(Editor.Project.path, 'profiles/v2/packages/builder.json');
        base = JSON.parse(fs.readFileSync(profile, 'utf8')).common;
    }
    if (!base) throw new Error('no build options found: run a build from the editor panel once first');
    return Object.assign({}, base, overrides || {});
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

async function callTool(name, a) {
    switch (name) {
        case 'editor_request':
            return await Editor.Message.request(a.pkg, a.method, ...(a.args || []));
        case 'editor_eval':
            return await new Function('Editor', 'require', `return (async () => { ${a.code} })()`)(Editor, require);
        case 'scene_eval':
            return await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp',
                method: 'run',
                args: [a.code],
            });
        case 'build': {
            const options = await buildOptions(a.overrides);
            const before = await Editor.Message.request('builder', 'query-tasks-info', { type: 'build' });
            const known = new Set((before.list || []).map((t) => t.id));
            const code = await Editor.Message.request('builder', 'add-task', options, !!a.wait);
            const after = await Editor.Message.request('builder', 'query-tasks-info', { type: 'build' });
            const task = (after.list || []).filter((t) => !known.has(t.id)).pop() || (after.list || []).pop();
            return {
                result: a.wait ? EXIT_CODE[code] || code : ADD_RESULT[code] || code,
                platform: options.platform,
                dest: `${options.buildPath}/${options.outputName}`,
                task: task ? taskBrief(task) : null,
            };
        }
        case 'build_status': {
            if (a.id) return taskBrief(await Editor.Message.request('builder', 'query-task', a.id));
            const info = await Editor.Message.request('builder', 'query-tasks-info', { type: 'build' });
            // info.queue is an id->task record of every task, not a pending queue — `free` is the busy flag.
            return { free: info.free, tasks: (info.list || []).map(taskBrief) };
        }
        case 'editor_log': {
            const file = path.join(Editor.Project.tmpDir, 'logs/project.log');
            const all = fs.readFileSync(file, 'utf8').split('\n');
            const lines = a.grep ? all.filter((l) => new RegExp(a.grep, 'i').test(l)) : all;
            return lines.slice(-(a.lines || 80)).join('\n');
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
                url: await Editor.Message.request('preview', 'query-preview-url'),
                ip: await Editor.Message.request('preview', 'get-preview-ip'),
                platform: await Editor.Profile.getConfig('preview', 'preview.current.platform', 'default'),
                connections: await Editor.Message.request('preview', 'query-connect-num'),
            };
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
        ? `${text.slice(0, MAX_CHARS)}\n...[truncated, ${text.length} chars total — narrow the query]`
        : text;
}

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
                previewUrl: await Editor.Message.request('preview', 'query-preview-url'),
                platform: await Editor.Profile.getConfig('preview', 'preview.current.platform', 'default'),
            };
        case 'cocos://scene/active':
            return await callTool('scene_eval', {
                code: "const s = cc.director.getScene(); if (!s) return null;" +
                      "const walk = (n, d = 0) => [{ d, name: n.name, comps: n.components.map(c => c.constructor.name) }, ...n.children.flatMap(c => walk(c, d + 1))];" +
                      "return { scene: s.name, nodes: walk(s) };",
            });
        case 'cocos://build/latest': {
            const info = await Editor.Message.request('builder', 'query-tasks-info', { type: 'build' });
            const last = (info.list || [])[0];
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
            protocolVersion: (params && params.protocolVersion) || '2025-06-18',
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

function onRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
        let msg;
        try {
            msg = JSON.parse(body);
        } catch (e) {
            res.writeHead(400).end();
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
