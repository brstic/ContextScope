import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { cmTheme } from './JsonViewer';

/** Side-by-side text diff (lazy-loaded). */
export default function MergeDiff({ a, b }: { a: string; b: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const ext = [cmTheme, EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new MergeView({ parent: host.current, a: { doc: a, extensions: ext }, b: { doc: b, extensions: ext }, collapseUnchanged: { margin: 3, minSize: 6 } });
    return () => view.destroy();
  }, [a, b]);
  return <div ref={host} className="max-h-[60vh] overflow-auto rounded-[4px] border border-border" aria-label="Text diff of request A and B" />;
}
