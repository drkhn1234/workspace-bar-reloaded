const PANEL_BOX_GAP = 6;

// Widths and bounds are in panel-local coordinates, independent of monitor
// position and scale. Keep the normal panel centre until a neighbour needs it
// to move; only the workspace bar gives up space when the panel becomes full.
export function computePanelLayout({
    panelWidth, naturalWidths, viewportWidth, viewportBox,
    centerPoint = panelWidth / 2, rtl = false,
}) {
    const widths = naturalWidths.map(width => Math.max(0, width));
    const occupied = widths.map((width, index) => width > 0 || index === viewportBox);
    const gaps = Math.max(0, occupied.filter(Boolean).length - 1) * PANEL_BOX_GAP;
    const reserved = widths.reduce((total, width) => total + width, 0) - viewportWidth;
    const availableWidth = Math.max(0, Math.floor(panelWidth - reserved - gaps));

    // A widget can grow, or the monitor can shrink, before the bar's next
    // preferred-width update. Constrain this allocation immediately as well.
    widths[viewportBox] = Math.max(0,
        widths[viewportBox] - Math.max(0, viewportWidth - availableWidth));

    const start = rtl ? 2 : 0;
    const end = rtl ? 0 : 2;
    const startGap = occupied[start] && occupied[1] ? PANEL_BOX_GAP : 0;
    const endGap = occupied[end] && occupied[1] ? PANEL_BOX_GAP : 0;
    const minCenter = widths[start] + startGap;
    const maxCenter = panelWidth - widths[end] - endGap - widths[1];
    const centerX = Math.max(minCenter,
        Math.min(centerPoint - widths[1] / 2, maxCenter));

    const bounds = [];
    bounds[start] = [0, widths[start]];
    bounds[1] = [centerX, centerX + widths[1]];
    bounds[end] = [panelWidth - widths[end], panelWidth];
    return {availableWidth, bounds};
}
