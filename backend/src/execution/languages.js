'use strict';

/**
 * The languages ZCoder supports, in one place.
 *
 * A room's language (rooms.language, synced to every editor through the Yjs
 * meta map) must be one of these ids, and so must an execution request.
 * `starter` seeds a brand-new room's shared document (on the server, so two
 * people opening an empty room can't both insert it).
 * `judge0Id` is the language id on Judge0 CE (GET /languages on a Judge0
 * instance lists them; these are the long-standing CE ids).
 * The local executor keeps its own commands (executors/localProcessExecutor.js).
 */
const LANGUAGES = Object.freeze({
  cpp: Object.freeze({
    id: 'cpp',
    label: 'C++17',
    monaco: 'cpp',
    judge0Id: 54, // C++ (GCC 9.2.0)
    compiled: true,
    starter:
      '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    string name;\n    getline(cin, name);\n    cout << "Hello, " << (name.empty() ? "world" : name) << "!" << endl;\n    return 0;\n}\n',
  }),
  python: Object.freeze({
    id: 'python',
    label: 'Python 3',
    monaco: 'python',
    judge0Id: 71, // Python (3.8.1)
    compiled: false,
    starter: 'import sys\n\nname = sys.stdin.readline().strip() or "world"\nprint(f"Hello, {name}!")\n',
  }),
  javascript: Object.freeze({
    id: 'javascript',
    label: 'JavaScript (Node.js)',
    monaco: 'javascript',
    judge0Id: 63, // JavaScript (Node.js 12.14.0)
    compiled: false,
    starter: "const input = require('fs').readFileSync(0, 'utf8').trim();\nconsole.log(`Hello, ${input || 'world'}!`);\n",
  }),
});

/** Ids as a non-empty tuple, the shape z.enum() wants. */
const LANGUAGE_IDS = /** @type {['cpp', 'python', 'javascript']} */ (Object.keys(LANGUAGES));

module.exports = { LANGUAGES, LANGUAGE_IDS };
