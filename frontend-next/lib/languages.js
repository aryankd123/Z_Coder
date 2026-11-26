/**
 * The languages the backend supports (backend/src/execution/languages.js).
 * `monaco` is the editor's language id; `starter` seeds a brand-new room's editor.
 */
export const LANGUAGES = [
  {
    id: 'cpp',
    label: 'C++17',
    monaco: 'cpp',
    starter: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    string name;\n    getline(cin, name);\n    cout << "Hello, " << (name.empty() ? "world" : name) << "!" << endl;\n    return 0;\n}\n',
  },
  {
    id: 'python',
    label: 'Python 3',
    monaco: 'python',
    starter: 'import sys\n\nname = sys.stdin.readline().strip() or "world"\nprint(f"Hello, {name}!")\n',
  },
  {
    id: 'javascript',
    label: 'JavaScript (Node.js)',
    monaco: 'javascript',
    starter: "const input = require('fs').readFileSync(0, 'utf8').trim();\nconsole.log(`Hello, ${input || 'world'}!`);\n",
  },
];

export const languageById = (id) => LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[2];
