# cocos-mcp

An MCP server that runs **inside** the Cocos Creator editor process, so an AI assistant can drive the
editor the same way you do: query the live scene graph, read and write assets, kick off builds, read the
log, and look at a screenshot of what it just did.

Eleven tools. Zero dependencies. No build step. Tested against Cocos Creator 3.8.8.

## Why eleven tools and not a hundred

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

### Ports

One editor instance per port. If you keep two projects open in Creator at once, the second one loses the
race for 1314 and silently has no server, so give each project its own port — either via `COCOS_MCP_PORT`,
or by dropping a `.port` file (gitignored) next to `main.js`:

```sh
echo 1315 > extensions/cocos-mcp/.port
```

Then point each project's MCP config at its own port. Keeping the server *name* the same across projects
means the tool names (`mcp__cocos-creator__*`) stay stable wherever you are:

```json
{ "projects": {
    "/path/to/project-a": { "mcpServers": { "cocos-creator": { "type": "http", "url": "http://127.0.0.1:1314/mcp" } } },
    "/path/to/project-b": { "mcpServers": { "cocos-creator": { "type": "http", "url": "http://127.0.0.1:1315/mcp" } } }
} }
```

## Tools

| Tool | What it does |
| --- | --- |
| `editor_request` | `Editor.Message.request(pkg, method, ...args)` — the entire editor API |
| `editor_eval` | Async JS in the editor main process; `Editor` and `require` in scope |
| `scene_eval` | Async JS in the scene process; `cc` and the live scene graph in scope |
| `editor_api` | Greps the editor's `.d.ts` files for a message signature |
| `asset_info` | One asset: size, sub-assets, resolved referencers, dependencies |
| `build` | Starts a build, reusing the last task's options; `overrides` to change fields |
| `build_status` | Task state, progress, and the messages carrying build errors |
| `editor_log` | Tails the project / builder / asset-db log with a regex filter |
| `screenshot` | Captures an editor window as a PNG image block |
| `preview` | Preview server URL, platform, and connection count |
| `reload` | Reloads this extension so code edits take effect |

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

**A reference index can name assets that are not in this checkout.** `query-asset-users` returns uuids, and
some of them resolve to nothing — other branches that share the same asset folder, or deleted files. On a
multi-game repo where every branch checks out only its own game code but shares `assets/common/`, this is
routine: one shared image reported 61 referencers on one branch and 94 on another, plus 15 unresolvable
either way. `asset_info` counts those separately as `ghostUsers` instead of silently inflating the total.

**A zero reference count is not permission to delete.** It only means nothing in *this* checkout references
it. Five images that looked dead on one branch turned out to be used by another game on a sibling branch.

**`scene_eval` returns must be JSON-serializable, and `undefined` used to be ambiguous.** The value crosses
a process boundary, so returning a live `Node`/`Component`/`Scene` fails with a circular-structure error —
return `node.name` or `node.children.map(n => n.name)` instead. And `undefined` means either "your code has
no return" or "the scene script was never registered", the second being completely silent; `scene_eval` now
pings the scene script before accepting an `undefined` and tells you to reload if it is dead.

**`@cocos/creator-types` only covers a fraction of the API.** The bundled types declare ~51 `scene`
messages; the running editor has 200+. `add-task`, `query-preview-url` and many others are declared only
in each installed package's own `@types` inside `CocosCreator.app`. `editor_api` scans both.

**`add-task` returns two different enums.** With `shouldWait: false` it returns `TaskAddResult`
(1 = SUCCESS); with `true` it returns `BuildExitCode` (36 = BUILD_SUCCESS). Same integer space, different
meanings. `build` decodes whichever applies.

**Build warnings are not in `build_status`.** Its `detailMessage` only carries the last hook name. Real
warnings and errors go to `temp/logs/project.log` — use `editor_log`.

**A second build queues silently, and `free` does not tell you.** `add-task` returns `SUCCESS` even when a
build is already running — the new task just sits there with `Wait a moment, build task is busy` in its
message. `query-tasks-info().free` stays `true` throughout, so it cannot be used to detect this; check task
`state` for `processing`/`waiting` instead. `build` now reports `queuedBehind` with those ids.
Cancel with `editor_request builder break-task [id]`.

**Bad build options queue successfully, then fail silently.** `add-task` accepts anything — an invalid
platform gets a cheerful `SUCCESS (queued)`, and the task only fails later with `构建参数校验失败` and an
*empty* `detailMessage`, so nothing tells you which option was wrong. `build` now runs options through the
builder's own `check-and-complete-options` first, which rejects them up front and lists the valid platforms.
That call also completes every required field and follows `taskName` to `outputName`, so it beats merging a
previous task's options by hand.

**Build detail lives in the builder's own log.** `temp/logs/project.log` gets the warnings, but
`editor_log` with `source: "builder"` reaches `temp/builder/log/`, which has per-stage timings and memory
tracking. Those files run to megabytes, so only the tail is read.

**Reloading needs a deferred disable/enable.** The `reload` tool handles it: it replies *first*, then tears
the server down 300 ms later — disabling the package kills the HTTP server, so doing it inline loses the
response. Keep-alive sockets would otherwise hold the port across a reload, so `unload()` destroys them
explicitly. Scene scripts are require-cached, so editing `scene-script.js` does nothing until you reload.

**Large results are truncated at 20 000 chars.** Do not retry a truncated call as-is — `query-assets` on a
folder blows the cap with a dozen assets. Loop inside `editor_eval` and return only the fields you need;
the round trips happen inside the editor and cost nothing.

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
node test.js
```

It binds port 19314 and aborts if that is taken, so it can never accidentally run its assertions
against a live editor. Override with `COCOS_MCP_PORT`.

## Security

`editor_eval` and `scene_eval` execute arbitrary code with full editor privileges. The server binds to
`127.0.0.1` only. Do not change that.

## License

MIT
