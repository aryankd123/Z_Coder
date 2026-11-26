/**
 * Unit tests for lib/monaco-binding.js with a minimal fake Monaco (no
 * browser): local typing reaches Yjs, remote Yjs changes reach the model,
 * two bound editors converge under concurrent typing, and other clients'
 * awareness data can't inject CSS.
 *
 * Run: npm test   (Node's built-in test runner; no extra dependencies)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

// The binding adds a <style> element for remote cursor colours.
const styles = [];
globalThis.document = {
  head: { appendChild: (el) => styles.push(el) },
  createElement: () => ({ textContent: '', remove() {} }),
};
const { MonacoBinding } = await import('../lib/monaco-binding.js');

// ---- a fake Monaco, just enough for the binding ----------------------------

class Range {
  constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
    Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
  }
}
const monaco = {
  Range,
  SelectionDirection: { LTR: 0, RTL: 1 },
  Selection: {
    createWithDirection: (sl, sc, el, ec, direction) => ({
      getStartPosition: () => ({ lineNumber: sl, column: sc }),
      getEndPosition: () => ({ lineNumber: el, column: ec }),
      getDirection: () => direction,
    }),
  },
  editor: { EndOfLineSequence: { LF: 0 }, TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 } },
};

class FakeModel {
  constructor(text = '') {
    this.text = text;
    this.listeners = new Set();
  }
  getValue() {
    return this.text;
  }
  setEOL() {}
  getOffsetAt({ lineNumber, column }) {
    const lines = this.text.split('\n');
    let offset = 0;
    for (let i = 0; i < lineNumber - 1; i += 1) offset += lines[i].length + 1;
    return offset + column - 1;
  }
  getPositionAt(offset) {
    const before = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length))).split('\n');
    return { lineNumber: before.length, column: before.at(-1).length + 1 };
  }
  /** Replace [start, end) and notify listeners, like Monaco does. */
  _replace(start, end, text) {
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    return { rangeOffset: start, rangeLength: end - start, text };
  }
  setValue(value) {
    const change = this._replace(0, this.text.length, value);
    this._emit([change]);
  }
  applyEdits(edits) {
    const changes = edits.map((e) => {
      const start = this.getOffsetAt({ lineNumber: e.range.startLineNumber, column: e.range.startColumn });
      const end = this.getOffsetAt({ lineNumber: e.range.endLineNumber, column: e.range.endColumn });
      return this._replace(start, end, e.text);
    });
    this._emit(changes);
  }
  /** Simulate the user typing: several changes in one event (like multi-cursor), offsets in the ORIGINAL text. */
  userEdit(changes) {
    const sorted = [...changes].sort((a, b) => b.offset - a.offset);
    const events = sorted.map((c) => this._replace(c.offset, c.offset + (c.remove ?? 0), c.text ?? ''));
    this._emit(events);
  }
  onDidChangeContent(fn) {
    const listener = fn;
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  _emit(changes) {
    for (const l of this.listeners) l({ changes });
  }
}

class FakeEditor {
  constructor(model) {
    this.model = model;
    this.selection = null;
    this.decorations = [];
  }
  getModel() {
    return this.model;
  }
  getSelection() {
    return this.selection;
  }
  setSelection(s) {
    this.selection = s;
  }
  onDidChangeCursorSelection() {
    return { dispose() {} };
  }
  createDecorationsCollection() {
    return { set: (d) => (this.decorations = d), clear: () => (this.decorations = []) };
  }
}

function bound(initial = '') {
  const doc = new Y.Doc();
  const ytext = doc.getText('code');
  if (initial) ytext.insert(0, initial);
  const model = new FakeModel();
  const editor = new FakeEditor(model);
  const awareness = new Awareness(doc);
  const binding = new MonacoBinding(monaco, ytext, model, editor, awareness);
  return {
    doc,
    ytext,
    model,
    editor,
    awareness,
    binding,
    destroy() {
      binding.destroy();
      awareness.destroy();
    },
  };
}

// ---- tests -----------------------------------------------------------------

test('the model starts with the Y.Text content', () => {
  const b = bound('int main() {}\n');
  assert.equal(b.model.getValue(), 'int main() {}\n');
  b.destroy();
});

test('local typing (including a multi-change event) reaches the Y.Text', () => {
  const b = bound('abc\ndef');
  b.model.userEdit([{ offset: 0, text: 'X' }, { offset: 4, remove: 3, text: 'Z' }]); // two cursors at once
  assert.equal(b.model.getValue(), 'Xabc\nZ');
  assert.equal(b.ytext.toString(), 'Xabc\nZ');
  b.destroy();
});

test('remote Y.Text inserts and deletes reach the model, on any line', () => {
  const b = bound('line1\nline2\nline3');
  b.doc.transact(() => {
    b.ytext.insert(6, '>> ');
    b.ytext.delete(0, 5);
  }, 'remote');
  assert.equal(b.ytext.toString(), '\n>> line2\nline3');
  assert.equal(b.model.getValue(), b.ytext.toString());
  b.destroy();
});

test('two bound editors typing concurrently converge (model == Y.Text on both sides)', () => {
  const left = bound('');
  const right = bound('');
  // Wire the two docs together the way the server does: relay every update.
  // While `live` is false, updates are queued instead: that makes edits truly concurrent.
  let live = true;
  const queued = [];
  const relay = (to) => (u, origin) => {
    if (origin === 'wire') return;
    if (live) Y.applyUpdate(to.doc, u, 'wire');
    else queued.push([to, u]);
  };
  left.doc.on('update', relay(right));
  right.doc.on('update', relay(left));

  left.model.userEdit([{ offset: 0, text: 'hello world' }]);
  assert.equal(right.model.getValue(), 'hello world');

  live = false;
  left.model.userEdit([{ offset: 5, text: ',' }]); // left sees "hello, world"
  right.model.userEdit([{ offset: 6, remove: 5, text: 'there' }]); // right sees "hello there"
  live = true;
  for (const [to, u] of queued) Y.applyUpdate(to.doc, u, 'wire');

  assert.equal(left.ytext.toString(), right.ytext.toString());
  assert.equal(left.model.getValue(), left.ytext.toString());
  assert.equal(right.model.getValue(), right.ytext.toString());
  assert.equal(left.model.getValue(), 'hello, there');
  left.destroy();
  right.destroy();
});

test("another client's awareness can't inject CSS through its name or colour", () => {
  const b = bound('abc');
  const other = new Y.Doc();
  const otherAwareness = new Awareness(other);
  // Pretend a remote client sent this state.
  b.awareness.states.set(999, {
    user: { name: 'x";}body{display:none}/*', color: 'red;background:url(evil)' },
    selection: {
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(b.ytext, 1)),
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(b.ytext, 2)),
    },
  });
  b.awareness.emit('change', [{ added: [999], updated: [], removed: [] }, 'remote']);
  const css = styles.at(-1).textContent;
  assert.ok(css.includes('.zc-sel-999'));
  assert.ok(!css.includes('display:none') && !css.includes('evil') && !css.includes('"x"'));
  assert.equal(b.editor.decorations.length, 1);
  otherAwareness.destroy();
  b.destroy();
});
