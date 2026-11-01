// Interpolate both edges, including when workspace cells have different widths
// or run right-to-left. Hidden cells are omitted by the caller.
export function workspaceHighlightBounds(boxes, value) {
    if (!boxes.length || !Number.isFinite(value)) return null;
    const ordered = [...boxes].sort((a, b) => a.index - b.index);
    let lower = ordered[0], upper = ordered.at(-1);
    for (const box of ordered) {
        if (box.index <= value) lower = box;
        if (box.index >= value) {upper = box; break;}
    }
    const fraction = upper.index === lower.index ? 0
        : Math.max(0, Math.min(1, (value - lower.index) / (upper.index - lower.index)));
    const mix = key => lower[key] + (upper[key] - lower[key]) * fraction;
    return {x: mix('x'), y: mix('y'), width: mix('width'), height: mix('height')};
}
