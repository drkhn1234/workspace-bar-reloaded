import {effectiveCompression, curveWeight, curveSpacingWeight, cutoffGate, samplingMap} from './magnificationCurve.js';

export function containsPoint(rect, x, y) {
    return x >= rect.x && x < rect.x + rect.width
        && y >= rect.y && y < rect.y + rect.height;
}

export function centerGlyph(ink, width, height, resourceScale = 1) {
    return {x: width / 2 - (ink.x + ink.width / 2) / resourceScale,
        y: height / 2 - (ink.y + ink.height / 2) / resourceScale};
}

export function opticalGlyphCenter(ink, contains, samples = 32) {
    const center = {x: ink.x + ink.width / 2, y: ink.y + ink.height / 2};
    let mass = 0, xSum = 0;
    for (let row = 0; row < samples; row++) {
        for (let column = 0; column < samples; column++) {
            const x = ink.x + (column + 0.5) * ink.width / samples;
            const y = ink.y + (row + 0.5) * ink.height / samples;
            if (contains(x, y)) { mass++; xSum += x; }
        }
    }
    if (!mass) return center;
    // Narrow digits such as 1 need more horizontal correction: most of their
    // ink is in the stem rather than the shoulder. Vertically, keep equal space
    // above and below the glyph: its ink mass can be biased towards the top.
    const constrain = (offset, limit) => Math.max(-limit, Math.min(limit, offset));
    return {x: center.x + constrain(xSum / mass - center.x, ink.width * 0.25),
        y: center.y};
}

// Interpolate the anchor between items so the dock never changes position
// abruptly when the pointer crosses the midpoint between two neighbours.
// The caller clips horizontally to free panel space, but not to panel height.
export function computeMagnificationLayout({
    icons, pointerX, progress, maxSize, left, right, bottom = false, spacing,
    minimumGroupSpacing = 0, appSpacing = minimumGroupSpacing,
    reach = 3, sharpness = 1, appOnly = true, numberMode = 'follow-app', numberScale = 1,
    magnifyEmpty = true, emptyHoverOnly = true, iconGap, numberGap,
    verticalAlignment = 'panel-edge', lift = 0, numberOffset = 0,
    cutoff = 1, cutoffSoftness = 0, adaptiveReach = false, reachReference = 8, reachResponse = 'fewer',
    spacingMode = 'curve', spacingFalloff = 1, compression, cutoffDistance = 96, cutoffEnabled = true,
}) {
    if (!icons.length || right <= left) return [];
    const amount = Math.max(0, Math.min(1, progress));
    const ordered = icons.map((icon, index) => ({...icon, index}))
        .sort((a, b) => a.x - b.x);
    const centerX = icon => icon.x + icon.width / 2;
    const apps = ordered.filter(icon => !icon.isWorkspaceNumber);
    const appWorkspaces = new Set(apps.map(icon => icon.workspace));
    const positions = new Map(ordered.map((icon, index) => [icon, index]));
    const appCenters = new Map();
    for (let i = 0; i < apps.length; i++) {
        const app = apps[i], previous = apps[i - 1];
        const consecutive = previous && positions.get(previous) + 1 === positions.get(app)
            && previous.workspace === app.workspace;
        const step = !previous ? 0 : consecutive ? centerX(app) - centerX(previous)
            : previous.width / 2 + Math.max(0, appSpacing) + app.width / 2;
        appCenters.set(app, previous ? appCenters.get(previous) + step : centerX(app));
    }
    // Map the pointer onto an app-only strip. A workspace number, empty
    // workspace or group separator consumes just one normal app-to-app gap.
    let appPointerX = pointerX;
    if (apps.length) {
        let anchor = 0;
        while (anchor < apps.length - 1 && centerX(apps[anchor + 1]) <= pointerX) anchor++;
        const app = apps[anchor], next = apps[Math.min(anchor + 1, apps.length - 1)];
        if (pointerX <= centerX(apps[0]) || app === next) {
            appPointerX = appCenters.get(app) + pointerX - centerX(app);
        } else {
            const fraction = (pointerX - centerX(app)) / (centerX(next) - centerX(app));
            appPointerX = appCenters.get(app)
                + (appCenters.get(next) - appCenters.get(app)) * fraction;
        }
    }
    const effectiveReach = magnificationReach(reach, apps.length || ordered.length, adaptiveReach, reachReference, reachResponse);
    const appRadius = Math.max(0, ...apps.map(icon => icon.width)) * effectiveReach;
    const numberRadius = Math.max(...ordered.map(icon => icon.width)) * effectiveReach;
    const pixelOptions = {compression: effectiveCompression(compression, apps.length || ordered.length, adaptiveReach, reachReference, reachResponse),
        sharpness, cutoffDistance, cutoffSoftness, cutoffEnabled, spacingMode, spacingFalloff, iconGap};
    const mapSample = compression === undefined ? x => x
        : samplingMap(pixelOptions, Math.max(1, ...apps.map(icon => icon.width)), appSpacing);
    const sampleDistance = icon => {
        const appCenter = appCenters.get(icon);
        const distance = appCenter === undefined ? centerX(icon) - pointerX
            : appOnly ? appCenter - appPointerX : centerX(icon) - pointerX;
        return appCenter === undefined ? distance : mapSample(distance);
    };
    const influence = icon => {
        const appCenter = appCenters.get(icon);
        const distance = Math.abs(sampleDistance(icon));
        const radius = appCenter === undefined ? numberRadius : appRadius;
        const weight = compression !== undefined ? curveWeight(distance, pixelOptions)
            : distance < radius ? profileWeight(distance / radius, sharpness, cutoffEnabled ? cutoff : 1, cutoffEnabled ? cutoffSoftness : 0) : 0;
        if (appCenter !== undefined || !icon.isWorkspaceNumber) return weight;
        const nearbyEmpty = !emptyHoverOnly && !appWorkspaces.has(icon.workspace);
        const ownHover = nearbyEmpty ? 1 : icon.independentHover ?? (distance < icon.width / 2
            ? (1 + Math.cos(Math.PI * distance / (icon.width / 2))) / 2 : 0);
        return weight * Math.max(0, Math.min(1, ownHover));
    };
    const references = ordered.map(icon => {
        if (!icon.isWorkspaceNumber || icon.workspace === undefined) return icon;
        // An ordinal follows the adjacent app in its own workspace. Empty
        // workspaces keep their independent hover magnification.
        return ordered.filter(other => !other.isWorkspaceNumber
            && other.workspace === icon.workspace).reduce((nearest, other) =>
            !nearest || Math.abs(centerX(other) - centerX(icon))
                < Math.abs(centerX(nearest) - centerX(icon)) ? other : nearest, null) ?? icon;
    });
    const result = [];
    const direction = bottom ? -1 : 1;
    const baseCenterY = ordered.reduce((sum, icon) => sum + icon.y + icon.height / 2, 0) / ordered.length;
    const sharedCenterY = baseCenterY + direction * Math.max(0,
        Math.min(maxSize, right - left) - Math.max(...ordered.map(icon => icon.height))) / 2 * amount;

    for (let i = 0; i < ordered.length; i++) {
        const icon = ordered[i];
        const reference = icon.isWorkspaceNumber && numberMode === 'own-workspace' ? icon : references[i];
        const numberDisabled = icon.isWorkspaceNumber && (numberMode === 'none'
            || (!magnifyEmpty && references[i] === icon));
        const weight = numberDisabled ? 0 : influence(reference);
        const peak = Math.min(Math.max(reference.width, maxSize), right - left);
        const width = icon.width + (Math.min(icon.width * peak / reference.width, right - left)
            - icon.width) * weight * amount * (icon.isWorkspaceNumber ? numberScale : 1);
        const height = icon.height * width / icon.width;
        const defaultY = bottom ? icon.y + icon.height - height : icon.y;
        // Vertical alignment is independent of whether/how much the number grows.
        const alignmentReference = references[i];
        const alignmentScale = 1 + (Math.min(Math.max(alignmentReference.width, maxSize), right - left)
            / alignmentReference.width - 1) * influence(alignmentReference) * amount;
        const referenceHeight = alignmentReference === icon ? height : alignmentReference.height * alignmentScale;
        const referenceCenterY = bottom
            ? alignmentReference.y + alignmentReference.height - referenceHeight / 2
            : alignmentReference.y + referenceHeight / 2;
        const centerY = (verticalAlignment === 'center-line' ? sharedCenterY
            : defaultY + height / 2 + (referenceCenterY - defaultY - height / 2) * amount)
            + direction * (lift + (icon.isWorkspaceNumber ? numberOffset : 0)) * amount;
        const leftInset = (icon.contentInsets?.left ?? 0) * width / icon.width * amount;
        const rightInset = (icon.contentInsets?.right ?? 0) * width / icon.width * amount;
        const originalGap = i === 0 ? 0 : Math.max(0,
            icon.x - ordered[i - 1].x - ordered[i - 1].width);
        const previous = ordered[i - 1];
        // Removing transparent ordinal padding must not change the normal
        // visual spacing outside the magnification region.
        const normalGap = originalGap + ((previous?.contentInsets?.right ?? 0)
            + (icon.contentInsets?.left ?? 0)) * amount;
        const ordinalToApps = previous && icon.workspace !== undefined
            && previous.workspace === icon.workspace
            && !!previous.isWorkspaceNumber !== !!icon.isWorkspaceNumber;
        const betweenWorkspaces = previous && icon.workspace !== undefined
            && previous.workspace !== undefined && previous.workspace !== icon.workspace;
        const before = i > 0 ? references[i - 1] : null;
        const after = references[i];
        const appBoundary = before && appCenters.has(before) && appCenters.has(after);
        const boundaryDistance = betweenWorkspaces ? Math.abs(appOnly && appBoundary
            ? (appCenters.get(before) + appCenters.get(after)) / 2 - appPointerX
            : (centerX(before) + centerX(after)) / 2 - pointerX) / (appBoundary ? appRadius : numberRadius) : 0;
        const boundaryGate = compression !== undefined
            ? cutoffGate((sampleDistance(before ?? icon) + sampleDistance(after)) / 2, cutoffDistance, cutoffSoftness, cutoffEnabled)
            : cutoffEnabled && (cutoff < 1 || cutoffSoftness > 0) ? spacingWeight(boundaryDistance, {spacingMode: 'uniform', cutoff, cutoffSoftness}) : 1;
        const gapWeight = ordinalToApps
            ? influence(icon.isWorkspaceNumber ? reference : references[i - 1])
            : betweenWorkspaces ? Math.max(weight, influence(references[i - 1])) * boundaryGate : 0;
        // Own-group spacing is automatic and measured from the visible digit
        // or ring. The preference controls only the separation of workspaces.
        const peakGap = betweenWorkspaces && spacing !== undefined ? Math.max(minimumGroupSpacing, spacing)
            : ordinalToApps ? numberGap ?? originalGap : normalGap;
        const customAppGap = previous && !previous.isWorkspaceNumber && !icon.isWorkspaceNumber
            && !betweenWorkspaces && iconGap !== undefined;
        const midpointDistance = customAppGap ? Math.abs((appOnly
            ? (appCenters.get(icon) + appCenters.get(previous)) / 2 - appPointerX
            : (centerX(icon) + centerX(previous)) / 2 - pointerX) / appRadius) : 0;
        const appGapWeight = customAppGap && compression !== undefined
            ? curveSpacingWeight((sampleDistance(icon) + sampleDistance(previous)) / 2, pixelOptions)
            : customAppGap ? spacingWeight(midpointDistance, {
            spacingMode, spacingFalloff, sharpness, cutoff: cutoffEnabled ? cutoff : 1, cutoffSoftness: cutoffEnabled ? cutoffSoftness : 0,
            // Preserve the established curve profile for the existing default.
            neighbourWeight: Math.max(influence(icon), influence(previous)),
        }) : 0;
        const gap = customAppGap ? originalGap + (iconGap - originalGap) * appGapWeight * amount
            : normalGap + (peakGap - normalGap) * gapWeight * amount;
        const x = i === 0 ? icon.x
            : result[i - 1].x + result[i - 1].width - result[i - 1].rightInset + gap - leftInset;
        result.push({index: icon.index, x,
            y: centerY - height / 2,
            width, height, leftInset, rightInset, sampleX: compression === undefined ? undefined : sampleDistance(icon)});
    }

    // Keep every control as a position anchor so numbers remain easy to
    // target. Only the app-only strip above determines magnification weights.
    const anchors = ordered.map((_icon, index) => index);
    const centers = anchors.map(index => centerX(ordered[index]));
    let anchor = 0;
    while (anchor < centers.length - 1 && centers[anchor + 1] <= pointerX) anchor++;
    const next = Math.min(anchor + 1, centers.length - 1);
    const fraction = next === anchor ? 0 : Math.max(0, Math.min(1,
        (pointerX - centers[anchor]) / (centers[next] - centers[anchor])));
    const blend = fraction * fraction * (3 - 2 * fraction);
    const lerp = (a, b) => a + (b - a) * blend;
    const center = index => result[index].x
        + (result[index].leftInset + result[index].width - result[index].rightInset) / 2;
    const anchorIndex = anchors[anchor], nextIndex = anchors[next];
    const focusCenter = lerp(center(anchorIndex), center(nextIndex));
    const visibleWidth = icon => icon.width - icon.leftInset - icon.rightInset;
    const focusWidth = lerp(visibleWidth(result[anchorIndex]), visibleWidth(result[nextIndex]));
    let offset = lerp(centers[anchor] - center(anchorIndex), centers[next] - center(nextIndex));
    const first = result[0];
    const last = result[result.length - 1];
    const firstX = first.x + first.leftInset;
    const lastRight = last.x + last.width - last.rightInset;
    const overflow = Math.max(0, lastRight - firstX - (right - left));
    // These bounds also vary continuously when the dock begins overflowing.
    // Keep the pointer's surrounding items visible while distant ones clip.
    // A fixed pixel field must keep the hovered target under the pointer.
    // Fitting the whole enlarged row can otherwise move it away as the pointer
    // follows it. Distant items may clip; the overlay still respects widgets.
    const lower = compression !== undefined ? left - focusCenter + focusWidth / 2
        : Math.max(left - firstX - overflow, left - focusCenter + focusWidth / 2);
    const upper = compression !== undefined ? right - focusCenter - focusWidth / 2
        : Math.min(right - lastRight + overflow, right - focusCenter - focusWidth / 2);
    offset = Math.max(lower, Math.min(offset, upper));
    return result.map(icon => ({...icon, x: icon.x + offset}))
        .sort((a, b) => a.index - b.index);
}

// The positive offset keeps the curve's slope at zero at its finite boundary,
// including soft sharpness values below 50%. At 100% this is the original cosine.
export function magnificationWeight(distance, sharpness = 1) {
    if (distance >= 1) return 0;
    const cosine = (1 + Math.cos(Math.PI * Math.max(0, distance))) / 2;
    if (sharpness === 1) return cosine;
    const offset = 0.01;
    return ((cosine + offset) ** sharpness - offset ** sharpness)
        / ((1 + offset) ** sharpness - offset ** sharpness);
}


export function magnificationReach(reach, count, adaptive = false, reference = 8, response = 'fewer') {
    if (!adaptive) return reach;
    const ratio = Math.max(1, count) / Math.max(1, reference);
    return reach * Math.min(1, response === 'more' ? 1 / ratio : ratio);
}

export function profileWeight(distance, sharpness = 1, cutoff = 1, softness = 0) {
    if (distance >= cutoff || cutoff <= 0) return 0;
    const blend = softness > 0 ? Math.min(1, (cutoff - distance) / (cutoff * softness)) : 1;
    return magnificationWeight(distance, sharpness) * blend * blend * (3 - 2 * blend);
}

export function spacingWeight(distance, {spacingMode = 'curve', spacingFalloff = 1,
    sharpness = 1, cutoff = 1, cutoffSoftness = 0, neighbourWeight} = {}) {
    // At the natural cosine boundary, adjacent endpoint weights already fade
    // smoothly to zero. A shorter cutoff deliberately clips that support.
    if (spacingMode === 'curve' && cutoff >= 1 && cutoffSoftness === 0 && neighbourWeight !== undefined) return neighbourWeight;
    if (distance >= cutoff || cutoff <= 0) return 0;
    const edge = cutoffSoftness > 0 ? Math.min(1, (cutoff - distance) / (cutoff * cutoffSoftness)) : 1;
    const fade = edge * edge * (3 - 2 * edge);
    if (spacingMode === 'uniform') return fade;
    if (spacingMode === 'diminishing') return (1 - distance / cutoff) ** spacingFalloff * fade;
    return (neighbourWeight ?? magnificationWeight(distance, sharpness)) * fade;
}
