import type { MouseEvent as TuiMouseEvent } from "@opentui/core";
import type { AppTheme } from "../../themes";
import { fitText } from "../../lib/text";
import { menuBarTitleWidth, type MenuId, type MenuSpec } from "./menu";

/** Render the top menu bar and the current changeset title. */
export function MenuBar({
  activeMenuId,
  menuSpecs,
  terminalWidth,
  theme,
  topTitle,
  onDismissMenu,
  onHoverMenu,
  onToggleMenu,
}: {
  activeMenuId: MenuId | null;
  menuSpecs: MenuSpec[];
  terminalWidth: number;
  theme: AppTheme;
  topTitle: string;
  onDismissMenu: () => void;
  onHoverMenu: (menuId: MenuId) => void;
  onToggleMenu: (menuId: MenuId) => void;
}) {
  return (
    // The outer row paints the app background so the bar keeps the same
    // one-column gutter the body panes have; only the inner band is chrome.
    // The row is left uncovered by the menu scrim so titles stay clickable,
    // which makes it responsible for dismissing on its own dead space.
    <box
      style={{
        height: 1,
        backgroundColor: theme.background,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 1,
        paddingRight: 1,
      }}
      onMouseUp={onDismissMenu}
    >
      <box
        style={{
          flexGrow: 1,
          height: 1,
          backgroundColor: theme.panelAlt,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        {menuSpecs.map((menu) => {
          const active = activeMenuId === menu.id;
          return (
            <box
              key={menu.id}
              style={{
                width: menu.width,
                height: 1,
                backgroundColor: active ? theme.accentMuted : theme.panelAlt,
              }}
              // A title owns its own click: without this the press would also
              // reach the row's dismiss handler and close what it just opened.
              onMouseUp={(event: TuiMouseEvent) => {
                event.stopPropagation();
                onToggleMenu(menu.id);
              }}
              onMouseOver={() => onHoverMenu(menu.id)}
            >
              <text fg={active ? theme.text : theme.muted}>{` ${menu.label} `}</text>
            </box>
          );
        })}

        <box style={{ flexGrow: 1, height: 1, alignItems: "center", justifyContent: "flex-end" }}>
          <text
            fg={theme.muted}
          >{` ${fitText(topTitle, menuBarTitleWidth(menuSpecs, terminalWidth))}`}</text>
        </box>
      </box>
    </box>
  );
}
