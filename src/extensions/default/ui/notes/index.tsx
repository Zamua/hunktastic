import type { ReactNode } from "react";
import { AllNotesPane } from "../../../../ui/components/panes/AllNotesPane";
import type { BundledPaneHostProps } from "../../../../ui/components/panes/ExtensionPane";
import type { ExtensionFactory } from "../../../types";

/**
 * The all-notes sidebar, shipped as a bundled extension like the file sidebar.
 *
 * Registering through `registerPane` is what gives it the lifecycle every other
 * docked pane has: one open/closed preference, host-owned geometry, a resizable
 * divider, and the same reveal rules on narrow terminals.
 *
 * Its contents and its jump are host props rather than published ones. The list
 * has to show notes that resolved to no line at all, which by definition never
 * become annotations on a file, and selecting a row has to place the current
 * line on the note's own anchor, which the published navigation cannot express.
 * Bundled UI is host code, so both arrive that way instead of widening the
 * contract every third-party pane must satisfy.
 */
export const BUNDLED_NOTES_VIEW_ID = "notes";

/** Render the all-notes list the host built for the selected file. */
export function BuiltInNotesView({
  noteEntries,
  theme,
  width,
  onSelectNote,
}: BundledPaneHostProps): ReactNode {
  return (
    <AllNotesPane
      entries={noteEntries ?? []}
      width={width}
      theme={theme}
      onSelectNote={onSelectNote ?? (() => {})}
    />
  );
}

/** The factory the bundled notes pane registers through, same as any extension. */
const registerBundledNotes: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: BUNDLED_NOTES_VIEW_ID,
    title: "All notes",
    placement: "right",
    width: { preferred: 38, min: 24 },
    defaultOpen: false,
    component: BuiltInNotesView,
  });
};

export default registerBundledNotes;
