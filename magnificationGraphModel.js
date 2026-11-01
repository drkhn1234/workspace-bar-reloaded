import {effectiveCompression, curveWeight, bellWeight, BASE_HALF_WIDTH} from './magnificationCurve.js';
import {computeMagnificationLayout, magnificationReach, profileWeight} from './magnificationLayout.js';
import {LIFT_MAX_UNITS} from './magnificationSettings.js';

// Pixel mode plots the runtime app sample coordinates on a fixed f(c*x).
// The legacy branch supports older layout consumers during migration.
export function magnificationGraphModel(options, normalSize, normalGap, count = 9) {
    count = Math.max(1, Math.min(31, Math.round(count)));
    const step = normalSize + normalGap;
    const icons = Array.from({length: count}, (_, index) => ({
        x: (index - (count - 1) / 2) * step - normalSize / 2,
        y: 0, width: normalSize, height: normalSize,
    }));
    const packed = computeMagnificationLayout({...options, icons, pointerX: 0, progress: 1,
        left: -1000000, right: 1000000, appSpacing: normalGap, bottom: true});
    if (options.compression !== undefined) {
        const compression = effectiveCompression(options.compression, count, options.adaptiveReach, options.reachReference, options.reachResponse);
        const config = {...options, compression};
        const peak = Math.max(1, options.maxSize / normalSize);
        const scaleAt = x => 1 + (peak - 1) * curveWeight(x, config);
        const halfWidth = BASE_HALF_WIDTH / compression;
        const pairs = packed.map(item => ({sample: item.sampleX, physical: item.x + item.width / 2}));
        const interpolate = (value, input, output) => {
            if (value <= pairs[0][input]) return pairs[0][output] + value - pairs[0][input];
            const last = pairs.at(-1);
            if (value >= last[input]) return last[output] + value - last[input];
            const next = pairs.findIndex(point => point[input] >= value), a = pairs[next - 1], b = pairs[next];
            return a[output] + (b[output] - a[output]) * (value - a[input]) / (b[input] - a[input]);
        };
        const toPhysical = value => interpolate(value, 'sample', 'physical');
        const toSample = value => interpolate(value, 'physical', 'sample');
        const topForScale = scale => options.verticalAlignment === 'center-line'
            ? normalSize - options.maxSize / 2 - normalSize * scale / 2
            : normalSize - normalSize * scale;
        const physicalScaleAt = x => scaleAt(toSample(x));
        const halfWidthX = toPhysical(halfWidth);
        const shoulderX = toPhysical(options.cutoffEnabled === false ? halfWidth * 0.8
            : Math.min(halfWidth * 0.8, options.cutoffDistance * 0.6));
        return {pixelUnits: true, normalSize, liftReserve: normalSize * LIFT_MAX_UNITS, packed, sourceIcons: icons, cutoffEnabled: options.cutoffEnabled !== false,
            markers: packed.map((item, index) => ({index, x: item.x + item.width / 2,
                y: item.width / normalSize, top: item.y, width: item.width, height: item.height,
                sampleX: item.sampleX, source: icons[index].x + normalSize / 2})),
            compression, peak, radius: halfWidth, reachX: halfWidthX,
            cutoffX: toPhysical(options.cutoffDistance), extent: options.graphSpan ?? 192,
            kernelScaleAt: scaleAt, scaleAt: physicalScaleAt,
            curveAt: x => ({x, y: physicalScaleAt(x)}),
            topAt: x => topForScale(physicalScaleAt(x)),
            bareScaleAt: x => 1 + (peak - 1) * bellWeight(toSample(x), compression, options.sharpness),
            bareTopAt: x => topForScale(1 + (peak - 1) * bellWeight(toSample(x), compression, options.sharpness)),
            topForScale, toSource: toSample, toPacked: toPhysical,
            shoulder: {x: shoulderX, y: physicalScaleAt(shoulderX)}};
    }
    const centres = icons.map((icon, i) => ({source: icon.x + normalSize / 2,
        packed: packed[i].x + packed[i].width / 2}));
    const interpolate = (value, input, output) => {
        if (value <= centres[0][input]) return centres[0][output] + value - centres[0][input];
        const last = centres.at(-1);
        if (value >= last[input]) return last[output] + value - last[input];
        const next = centres.findIndex(point => point[input] >= value), a = centres[next - 1], b = centres[next];
        return a[output] + (b[output] - a[output]) * (value - a[input]) / (b[input] - a[input]);
    };
    const toPacked = value => interpolate(value, 'source', 'packed');
    const toSource = value => interpolate(value, 'packed', 'source');
    const radius = normalSize * magnificationReach(options.reach, count, options.adaptiveReach, options.reachReference, options.reachResponse);
    const cutoff = radius * options.cutoff;
    const peak = Math.max(1, options.maxSize / normalSize);
    const marker = (item, index) => ({index, x: (item.x + item.width / 2) / normalSize,
        y: item.width / normalSize, source: centres[index].source / normalSize});
    const markers = packed.map(marker);
    const curveAt = source => ({x: toPacked(source) / normalSize,
        y: 1 + (peak - 1) * profileWeight(Math.abs(source) / radius, options.sharpness, options.cutoff, options.cutoffSoftness)});
    const reachX = toPacked(radius) / normalSize;
    const cutoffX = toPacked(cutoff) / normalSize;
    const extent = Math.max(3, reachX * 1.3, ...markers.map(point => Math.abs(point.x) + 1));
    return {markers, peak, radius: radius / normalSize, reachX, cutoffX, extent,
        curveAt, toPacked, toSource,
        shoulder: curveAt(radius * Math.min(0.45, options.cutoff * 0.6)),
        scaleAt: x => curveAt(toSource(x * normalSize)).y,
    };
}


// A common factor for x, y, icon width and icon height preserves physical
// proportions. At 100%, one logical pixel in the shell is one in preferences.
export function magnificationGraphViewport(model, width, height, zoom = 1) {
    const left = 48, right = width - 24, top = 26, footer = 58;
    const centre = (left + right) / 2;
    // Reserve the full Lift range so changing placement never moves the axes,
    // resizes the canvas, or causes the scroll view to recenter.
    const minimumTop = Math.min(0, model.topForScale(model.peak) - (model.liftReserve ?? 0));
    const floor = height - footer;
    return {centre, floor, zoom, unitX: zoom, unitY: model.normalSize * zoom,
        baseline: floor - model.normalSize * zoom, left, right, top,
        px: x => centre + x * zoom,
        py: scale => floor + (model.topForScale(scale) - model.normalSize) * zoom,
        physicalY: y => floor + (y - model.normalSize) * zoom,
        contentHeight: Math.max(180, top + (model.normalSize - minimumTop) * zoom + footer),
    };
}
