import { json } from '@codemirror/lang-json';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export const cmTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: '2px solid var(--ring)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--raised)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', border: 'none', color: 'var(--muted)' },
});

/** Read-only CodeMirror JSON view. Loaded lazily (only on the Raw tab). */
export default function JsonViewer({ value, label }: { value: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          json(),
          cmTheme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
        ],
      }),
    });
    return () => view.destroy();
  }, [value, label]);
  return <div ref={host} className="max-h-[60vh] overflow-auto rounded-[4px] border border-border" />;
}
