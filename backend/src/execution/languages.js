'use strict';

/**
 * The languages ZCoder supports, in one place.
 *
 * A room's language (rooms.language, synced to every editor through the Yjs
 * meta map) must be one of these ids, and so must an execution request.
 * Phase 4 adds the per-language execution settings (Judge0 ids, local
 * commands, time limits) to this same table.
 */
const LANGUAGES = Object.freeze({
  cpp: Object.freeze({ id: 'cpp', label: 'C++17', monaco: 'cpp' }),
  python: Object.freeze({ id: 'python', label: 'Python 3', monaco: 'python' }),
  javascript: Object.freeze({ id: 'javascript', label: 'JavaScript (Node.js)', monaco: 'javascript' }),
});

/** Ids as a non-empty tuple, the shape z.enum() wants. */
const LANGUAGE_IDS = /** @type {['cpp', 'python', 'javascript']} */ (Object.keys(LANGUAGES));

module.exports = { LANGUAGES, LANGUAGE_IDS };
