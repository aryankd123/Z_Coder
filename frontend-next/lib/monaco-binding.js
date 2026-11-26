/**
 * Two-way binding between a Y.Text and a Monaco editor model, plus remote
 * cursors from Yjs awareness.
 *
 * It's a compact version of the y-monaco binding. We wrote our own because
 * y-monaco imports the `monaco-editor` package directly, which would bundle
 * all of Monaco (and its web workers) into the Next.js build.
 * @monaco-editor/react loads Monaco from a CDN instead, and this binding
 * uses that `monaco` instance, passed in.
 *
 *   Monaco -> Yjs: onDidChangeContent gives the changes with offsets; we
 *                  replay them on the Y.Text inside ONE transaction whose
 *                  origin is this binding.
 *   Yjs -> Monaco: ytext.observe gives a delta (retain / insert / delete);
 *                  we turn it into Monaco edits. Changes whose origin is this
 *                  binding are skipped (they came from Monaco in the first place).
 *   A flag (`applyingRemote`) stops the Monaco listener from re-sending
 *   remote edits back to Yjs.
 *
 * Your own cursor across remote edits: before any transaction we store the
 * selection as Yjs *relative* positions (anchored to characters, not
 * offsets), and restore it afterwards, so someone typing above you doesn't
 * shift your caret.
 */
import * as Y from 'yjs';

/** Only #rrggbb colours reach CSS (awareness state comes from other clients: untrusted). */
const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#f59e0b');
/** Only letters, digits, spaces and . _ - reach the CSS `content:` string. */
const safeName = (n) => (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 24) : '') || 'guest';

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class MonacoBinding {
  /**
   * @param {typeof import('monaco-editor')} monaco the instance from @monaco-editor/react
   * @param {Y.Text} ytext
   * @param {import('monaco-editor').editor.ITextModel} model
   * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
   * @param {import('y-protocols/awareness').Awareness} awareness
   */
  constructor(monaco, ytext, model, editor, awareness) {
    this.monaco = monaco;
    this.ytext = ytext;
    this.doc = ytext.doc;
    this.model = model;
    this.editor = editor;
    this.awareness = awareness;
    this.applyingRemote = false;
    this.savedSelection = null;
    this.decorations = editor.createDecorationsCollection();
    this.style = document.createElement('style');
    document.head.appendChild(this.style);

    // Offsets must mean the same thing on both sides: use \n everywhere.
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    if (model.getValue() !== ytext.toString()) this._withRemote(() => model.setValue(ytext.toString()));

    // Remember the local selection before any Yjs change...
    this._beforeTransaction = () => {
      const sel = editor.getSelection();
      if (!sel || editor.getModel() !== model) return;
      this.savedSelection = {
        start: Y.createRelativePositionFromTypeIndex(ytext, model.getOffsetAt(sel.getStartPosition())),
        end: Y.createRelativePositionFromTypeIndex(ytext, model.getOffsetAt(sel.getEndPosition())),
        direction: sel.getDirection(),
      };
    };
    this.doc.on('beforeAllTransactions', this._beforeTransaction);

    // Yjs -> Monaco.
    this._observer = (event, transaction) => {
      if (transaction.origin === this) return;
      this._withRemote(() => {
        let index = 0;
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const pos = model.getPositionAt(index);
            model.applyEdits([{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: op.insert }]);
            index += op.insert.length;
          } else if (op.delete !== undefined) {
            const from = model.getPositionAt(index);
            const to = model.getPositionAt(index + op.delete);
            model.applyEdits([{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: '' }]);
          }
        }
        this._restoreSelection();
      });
      this._renderCursors();
    };
    ytext.observe(this._observer);

    // Monaco -> Yjs. Apply right-to-left so earlier offsets stay valid.
    this._contentListener = model.onDidChangeContent((e) => {
      if (this.applyingRemote) return;
      this.doc.transact(() => {
        [...e.changes]
          .sort((a, b) => b.rangeOffset - a.rangeOffset)
          .forEach((change) => {
            if (change.rangeLength > 0) ytext.delete(change.rangeOffset, change.rangeLength);
            if (change.text) ytext.insert(change.rangeOffset, change.text);
          });
      }, this);
    });

    // My cursor -> awareness (as relative positions, so they survive concurrent edits).
    this._cursorListener = editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection();
      if (!sel || editor.getModel() !== model) return;
      let anchor = model.getOffsetAt(sel.getStartPosition());
      let head = model.getOffsetAt(sel.getEndPosition());
      if (sel.getDirection() === monaco.SelectionDirection.RTL) [anchor, head] = [head, anchor];
      awareness.setLocalStateField('selection', {
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, anchor)),
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, head)),
      });
    });

    this._renderCursors = this._renderCursors.bind(this);
    awareness.on('change', this._renderCursors);
    this._renderCursors();
  }

  _withRemote(fn) {
    this.applyingRemote = true;
    try {
      fn();
    } finally {
      this.applyingRemote = false;
    }
  }

  _restoreSelection() {
    const saved = this.savedSelection;
    if (!saved || this.editor.getModel() !== this.model) return;
    const start = Y.createAbsolutePositionFromRelativePosition(saved.start, this.doc);
    const end = Y.createAbsolutePositionFromRelativePosition(saved.end, this.doc);
    if (!start || !end) return;
    const s = this.model.getPositionAt(start.index);
    const e = this.model.getPositionAt(end.index);
    this.editor.setSelection(
      this.monaco.Selection.createWithDirection(s.lineNumber, s.column, e.lineNumber, e.column, saved.direction),
    );
  }

  /** Remote selections as decorations; one CSS class per remote client for its colour and name tag. */
  _renderCursors() {
    const css = [];
    const decorations = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID || !state?.selection?.anchor || !state?.selection?.head) return;
      let anchor;
      let head;
      try {
        anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.selection.anchor), this.doc);
        head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.selection.head), this.doc);
      } catch {
        return; // malformed state from another client: ignore it
      }
      if (!anchor || !head || anchor.type !== this.ytext || head.type !== this.ytext) return;

      const id = Number(clientId);
      const color = safeColor(state.user?.color);
      const name = safeName(state.user?.name);
      css.push(
        `.zc-sel-${id}{background-color:${hexToRgba(color, 0.25)}}`,
        `.zc-head-${id}{position:relative;border-left:2px solid ${color};margin-left:-1px}`,
        `.zc-head-${id}::after{content:"${name}";position:absolute;top:-1.15em;left:-2px;background:${color};color:#0f172a;font-size:10px;line-height:1.2;padding:0 3px;border-radius:2px;white-space:nowrap;pointer-events:none;z-index:10}`,
      );

      const forward = anchor.index <= head.index;
      const from = this.model.getPositionAt(forward ? anchor.index : head.index);
      const to = this.model.getPositionAt(forward ? head.index : anchor.index);
      decorations.push({
        range: new this.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
        options: {
          className: `zc-sel-${id}`,
          // The caret sits at the head: after the range when selecting forwards.
          afterContentClassName: forward ? `zc-head-${id}` : null,
          beforeContentClassName: forward ? null : `zc-head-${id}`,
          stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    });
    this.style.textContent = css.join('\n');
    this.decorations.set(decorations);
  }

  destroy() {
    this._contentListener.dispose();
    this._cursorListener.dispose();
    this.ytext.unobserve(this._observer);
    this.doc.off('beforeAllTransactions', this._beforeTransaction);
    this.awareness.off('change', this._renderCursors);
    this.decorations.clear();
    this.style.remove();
  }
}
