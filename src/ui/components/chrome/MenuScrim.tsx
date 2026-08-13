import type { MouseEvent as TuiMouseEvent } from "@opentui/core";

/**
 * Swallow the click that dismisses an open menu.
 *
 * Panes handle their own mouse events and stop them there, so an ancestor
 * handler never sees the press that should close a menu; one transparent layer
 * over the body makes "click away to close" a single behavior instead of an
 * opt-in every pane has to remember. Being the hit target is what keeps a
 * dismissing click from also moving the line cursor, selecting a file, or
 * starting a pane resize: the press resolves here and never reaches the pane
 * below.
 *
 * Two things stay reachable on purpose. The menu bar sits above `top`, so a
 * click on another title still switches menus rather than only closing, and the
 * dropdown outranks this layer by z-index, so its items still run.
 */
export function MenuScrim({
  top,
  height,
  onDismiss,
}: {
  top: number;
  height: number;
  onDismiss: () => void;
}) {
  /** End the press here: no ancestor handler, and no focus follow on the press. */
  const consume = (event: TuiMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <box
      style={{ position: "absolute", left: 0, top, width: "100%", height, zIndex: 35 }}
      onMouseDown={consume}
      // Closing on release, not on press, keeps both halves of the click on
      // this layer: a scrim removed at press time would let the release land
      // on the pane below.
      onMouseUp={(event) => {
        consume(event);
        onDismiss();
      }}
      // The wheel resolves here too, so the review below can never see it while
      // a menu is open. Dismissing on the first notch keeps the pointer alive:
      // the alternative is a wheel that silently does nothing at all.
      onMouseScroll={(event) => {
        consume(event);
        onDismiss();
      }}
    />
  );
}
