'use strict';

/**
 * The languages ZCoder supports, in one place.
 *
 * A room's language (rooms.language, synced to every editor through the Yjs
 * meta map) must be one of these ids, and so must an execution request.
 * `starter` seeds a brand-new room's shared document (on the server, so two
 * people opening an empty room can't both insert it).
 * Phase 4 adds the per-language execution settings to this same table.
 */
const LANGUAGES = Object.freeze({
  cpp: Object.freeze({
    id: 'cpp',
    label: 'C++17',
    monaco: 'cpp',
    starter:
      '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    string name;\n    getline(cin, name);\n    cout << "Hello, " << (name.empty() ? "world" : name) << "!" << endl;\n    return 0;\n}\n',
  }),
  python: Object.freeze({
    id: 'python',
    label: 'Python 3',
    monaco: 'python',
    starter: 'import sys\n\nname = sys.stdin.readline().strip() or "world"\nprint(f"Hello, {name}!")\n',
  }),
  javascript: Object.freeze({
    id: 'javascript',
    label: 'JavaScript (Node.js)',
    monaco: 'javascript',
    starter: "const input = require('fs').readFileSync(0, 'utf8').trim();\nconsole.log(`Hello, ${input || 'world'}!`);\n",
  }),
});

/** Ids as a non-empty tuple, the shape z.enum() wants. */
const LANGUAGE_IDS = /** @type {['cpp', 'python', 'javascript']} */ (Object.keys(LANGUAGES));

module.exports = { LANGUAGES, LANGUAGE_IDS };
