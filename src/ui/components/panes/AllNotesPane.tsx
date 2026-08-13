import { memo, type ReactNode } from "react";
import type { ExtensionPaneTheme } from "../../../extension-api/types";
import { noteRowId } from "../../lib/ids";
import type { ReviewNoteEntry, ReviewNoteGroup } from "../../lib/reviewNotes";
import { fitText } from "../../lib/text";

/**
 * The all-notes list: every note the review still holds, grouped by file,
 * whether or not the diff has a line to put each one on.
 *
 * The inline layer answers "what is this code about"; this pane answers "what
 * did I say about this review", which is why it spans every file and why an
 * unplaceable note stays here after the line it was written against is gone.
 * Rows render from the public pane theme tokens, like the file sidebar's rows
 * do.
 */

/** Render one note row, plus the anchor text when the note has nowhere to sit. */
const NoteListItem = memo(function NoteListItem({
  entry,
  selected,
  textWidth,
  theme,
  onSelectNote,
}: {
  entry: ReviewNoteEntry;
  selected: boolean;
  textWidth: number;
  theme: ExtensionPaneTheme;
  onSelectNote: (fileId: string, noteId: string) => void;
}) {
  // A placeable note leads with where it sits; an unplaceable one leads with why it does not.
  const label = entry.placeable ? (entry.location ?? "") : entry.state;
  const labelColor = entry.placeable ? theme.noteBorder : theme.muted;
  const summaryColor = entry.placeable ? theme.text : theme.muted;
  // The accent bar takes the first column, exactly as a selected file row's does.
  const rowBackground = selected ? theme.panelAlt : theme.panel;
  const contentWidth = Math.max(1, textWidth - 1);
  const summaryWidth = Math.max(1, contentWidth - (label ? label.length + 1 : 0));
  const anchorText = entry.anchorText?.trim();

  return (
    <box
      id={noteRowId(entry.id)}
      style={{ width: "100%", flexDirection: "row", backgroundColor: rowBackground }}
      // A note with no line in this diff has nowhere to send the review, so its row is inert
      // rather than jumping to a position the note is not about.
      onMouseUp={entry.placeable ? () => onSelectNote(entry.fileId, entry.id) : undefined}
    >
      <box
        style={{
          width: 1,
          flexShrink: 0,
          backgroundColor: selected ? theme.accent : rowBackground,
        }}
      />
      <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: rowBackground }}>
        <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
          {label ? <text fg={labelColor}>{`${label} `}</text> : null}
          <text fg={summaryColor}>{fitText(entry.summary, summaryWidth)}</text>
        </box>
        {anchorText ? (
          <box style={{ width: "100%", height: 1, paddingLeft: 2, flexDirection: "row" }}>
            <text fg={theme.muted}>{fitText(anchorText, Math.max(1, contentWidth - 2))}</text>
          </box>
        ) : null}
      </box>
    </box>
  );
});

/** Render one file heading above the notes that belong to it. */
const NoteGroupHeading = memo(function NoteGroupHeading({
  label,
  textWidth,
  theme,
}: {
  label: string;
  textWidth: number;
  theme: ExtensionPaneTheme;
}) {
  return (
    <box style={{ width: "100%", height: 1, backgroundColor: theme.panel }}>
      <text fg={theme.accent}>{fitText(label, textWidth)}</text>
    </box>
  );
});

export interface AllNotesPaneProps {
  groups: readonly ReviewNoteGroup[];
  /** The note the review is currently on; its row carries the selected treatment. */
  currentNoteId?: string | null;
  width: number;
  theme: ExtensionPaneTheme;
  onSelectNote: (fileId: string, noteId: string) => void;
}

/** Render every note in the review as a selectable list, grouped by file. */
export function AllNotesPane({
  groups,
  currentNoteId,
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
        {groups.length === 0 ? (
          <text fg={theme.muted}>{fitText("No notes in this review", textWidth)}</text>
        ) : (
          groups.map((group) => (
            // Grouping is per file, and a file the review dropped keeps its stored path as the
            // heading, so the key covers both instead of assuming a file id exists.
            <box
              key={`${group.fileId}\0${group.label}`}
              style={{ width: "100%", flexDirection: "column" }}
            >
              <NoteGroupHeading label={group.label} textWidth={textWidth} theme={theme} />
              {/* No indent here: each row's own accent column supplies it, so a selected
                  row's bar lands where the indent was. */}
              <box style={{ width: "100%", flexDirection: "column" }}>
                {group.entries.map((entry) => (
                  <NoteListItem
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === currentNoteId && entry.fileId === group.fileId}
                    textWidth={textWidth}
                    theme={theme}
                    onSelectNote={onSelectNote}
                  />
                ))}
              </box>
            </box>
          ))
        )}
      </box>
    </scrollbox>
  );
}
