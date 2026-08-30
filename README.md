# cocos-mcp

An MCP server that runs **inside** the Cocos Creator editor process, so an AI assistant can drive the
editor the same way you do: query the live scene graph, read and write assets, kick off builds, read the
log, and look at a screenshot of what it just did.

Nine tools. Zero dependencies. No build step. Tested against Cocos Creator 3.8.8.

## Why nine tools and not a hundred

The editor API is huge — `scene` alone declares 200+ messages. Wrapping each one as its own MCP tool means
a giant tool list permanently occupying the model's context, and a maintenance burden every time Creator
ships a release. Other Cocos MCP servers expose 100+ tools and then have to add "tool profiles" to hide
most of them again.

Instead this exposes a few general tools plus one that reads the editor's own TypeScript definitions, so
the model looks up a signature and then calls it. Everything the big servers do with `create_label`,
`set_node_transform`, `duplicate_prefab` and so on is one `editor_request` call here.

## Install

1. Copy this folder to `<your-project>/extensions/cocos-mcp`.
2. In Creator: **Extension → Extension Manager → Project**, enable `cocos-mcp`.
   The console should print `[cocos-mcp] http://127.0.0.1:1314/mcp`.
3. Point your MCP client at it. For Claude Code:

   ```json
   { "mcpServers": { "cocos-creator": { "type": "http", "url": "http://127.0.0.1:1314/mcp" } } }
   ```

Set `COCOS_MCP_PORT` to use a different port.

## Tools

| Tool | What it does |
| --- | --- |
| `editor_request` | `Editor.Message.request(pkg, method, ...args)` — the entire editor API |
| `editor_eval` | Async JS in the editor main process; `Editor` and `require` in scope |
| `scene_eval` | Async JS in the scene process; `cc` and the live scene graph in scope |
| `editor_api` | Greps the editor's `.d.ts` files for a message signature |
| `build` | Starts a build, reusing the last task's options; `overrides` to change fields |
| `build_status` | Task state, progress, and the messages carrying build errors |
| `editor_log` | Tails `temp/logs/project.log` with a regex filter |
| `screenshot` | Captures an editor window as a PNG image block |
| `preview` | Preview server URL, platform, and connection count |

## Resources

`cocos://project`, `cocos://scene/active`, `cocos://build/latest`, `cocos://log/recent`.

## Gotchas

Each of these cost real debugging time. They are why this README exists.

**A scene script must export `methods`.** Exporting the functions at the top level makes
`execute-scene-script` return `undefined` — silently, with no error, even though the extension is enabled
and `contributions.scene.script` is correct.

```js
exports.methods = { run(code) { /* ... */ } };   // right
module.exports = { run(code) { /* ... */ } };    // silently never called
```

**`@cocos/creator-types` only covers a fraction of the API.** The bundled types declare ~51 `scene`
messages; the running editor has 200+. `add-task`, `query-preview-url` and many others are declared only
in each installed package's own `@types` inside `CocosCreator.app`. `editor_api` scans both.

**`add-task` returns two different enums.** With `shouldWait: false` it returns `TaskAddResult`
(1 = SUCCESS); with `true` it returns `BuildExitCode` (36 = BUILD_SUCCESS). Same integer space, different
meanings. `build` decodes whichever applies.

**Build warnings are not in `build_status`.** Its `detailMessage` only carries the last hook name. Real
warnings and errors go to `temp/logs/project.log` — use `editor_log`.

**Reloading the extension needs a deferred disable/enable**, or the HTTP response dies before it is sent:

```js
// via editor_eval
const p = Editor.Project.path + '/extensions/cocos-mcp';
setTimeout(async () => {
    Editor.Package.disable(p);
    await new Promise(r => setTimeout(r, 800));
    Editor.Package.enable(p);
}, 300);
return 'scheduled';
```

Keep-alive sockets otherwise hold the port open across a reload, so `unload()` destroys them explicitly.

**Driving the running game** is a browser automation job — `preview` just hands over the URL. Two things
that bite when clicking the canvas from Puppeteer/Playwright:

- The engine registers `mousedown`/`mouseup` on the canvas (`pal/input/web/mouse-input.ts`).
  Synthetic `PointerEvent`s are ignored.
- `cc.UITransform` is `undefined` on the preview page's `cc` global; use `node.worldPosition`, or
  `getComponent('cc.UITransform')` by string. And re-measure `getBoundingClientRect()` every time — the
  preview's device toolbar collapses and shifts the canvas.

```js
const cam = cc.director.getScene().getComponentInChildren('cc.Canvas').cameraComponent;
const s = cam.worldToScreen(cc.find('Canvas/path/to/node').worldPosition);
const r = document.querySelector('canvas').getBoundingClientRect();
const base = { bubbles: true, cancelable: true, view: window, button: 0,
    clientX: r.x + s.x / devicePixelRatio,
    clientY: r.y + (r.height - s.y / devicePixelRatio) };  // Cocos origin is bottom-left
canvas.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
canvas.dispatchEvent(new MouseEvent('mouseup',   { ...base, buttons: 0 }));
```

## Tests

Runs offline against a stubbed `Editor` — no editor needed:

```sh
COCOS_MCP_PORT=1315 node test.js
```

## Security

`editor_eval` and `scene_eval` execute arbitrary code with full editor privileges. The server binds to
`127.0.0.1` only. Do not change that.

## License

MIT
