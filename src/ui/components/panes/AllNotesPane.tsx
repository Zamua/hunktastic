import { memo, type ReactNode } from "react";
import type { ExtensionPaneTheme } from "../../../extension-api/types";
import { noteRowId } from "../../lib/ids";
import type { ReviewNoteEntry } from "../../lib/reviewNotes";
import { fitText } from "../../lib/text";

/**
 * The all-notes list: every note the review still holds for the selected file,
 * whether or not this diff has a line to put it on.
 *
 * The inline layer answers "what is this code about"; this pane answers "what
 * did I say about this file", which is why an unplaceable note stays here after
 * the line it was written against is gone. Rows render from the public pane
 * theme tokens, like the file sidebar's rows do.
 */

/** Render one note row, plus the anchor text when the note has nowhere to sit. */
const NoteListItem = memo(function NoteListItem({
  entry,
  textWidth,
  theme,
  onSelectNote,
}: {
  entry: ReviewNoteEntry;
  textWidth: number;
  theme: ExtensionPaneTheme;
  onSelectNote: (fileId: string, noteId: string) => void;
}) {
  // A placeable note leads with where it sits; an unplaceable one leads with why it does not.
  const label = entry.placeable ? (entry.location ?? "") : entry.state;
  const labelColor = entry.placeable ? theme.noteBorder : theme.muted;
  const summaryColor = entry.placeable ? theme.text : theme.muted;
  const summaryWidth = Math.max(1, textWidth - (label ? label.length + 1 : 0));
  const anchorText = entry.anchorText?.trim();

  return (
    <box
      id={noteRowId(entry.id)}
      style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}
      // A note with no line in this diff has nowhere to send the review, so its row is inert
      // rather than jumping to a position the note is not about.
      onMouseUp={entry.placeable ? () => onSelectNote(entry.fileId, entry.id) : undefined}
    >
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        {label ? <text fg={labelColor}>{`${label} `}</text> : null}
        <text fg={summaryColor}>{fitText(entry.summary, summaryWidth)}</text>
      </box>
      {anchorText ? (
        <box style={{ width: "100%", height: 1, paddingLeft: 2, flexDirection: "row" }}>
          <text fg={theme.muted}>{fitText(anchorText, Math.max(1, textWidth - 2))}</text>
        </box>
      ) : null}
    </box>
  );
});

export interface AllNotesPaneProps {
  entries: readonly ReviewNoteEntry[];
  width: number;
  theme: ExtensionPaneTheme;
  onSelectNote: (fileId: string, noteId: string) => void;
}

/** Render every note on the selected file as a selectable list. */
export function AllNotesPane({
  entries,
  width,
  theme,
  onSelectNote,
}: AllNotesPaneProps): ReactNode {
  // Mirrors the file sidebar: one column of row padding on each side.
  const textWidth = Math.max(8, width - 2);

  return (
    <scrollbox
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      viewportCulling={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", paddingLeft: 1, flexDirection: "column" }}>
        {entries.length === 0 ? (
          <text fg={theme.muted}>{fitText("No notes on this file", textWidth)}</text>
        ) : (
          entries.map((entry) => (
            <NoteListItem
              key={entry.id}
              entry={entry}
              textWidth={textWidth}
              theme={theme}
              onSelectNote={onSelectNote}
            />
          ))
        )}
      </box>
    </scrollbox>
  );
}
