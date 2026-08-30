'use strict';

// Runs in the scene process, where `cc` and the live scene graph exist.
// Creator looks methods up under `methods` — exporting them at top level fails silently.
// Return plain JSON-serializable data: the value crosses an IPC boundary.
exports.load = function () {};
exports.unload = function () {};

exports.methods = {
    ping() {
        return 'pong';
    },
    async run(code) {
        const cc = require('cc');
        return await new Function('cc', 'Editor', 'require', `return (async () => { ${code} })()`)(cc, Editor, require);
    },
};
