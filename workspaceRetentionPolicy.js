// Deadlines belong to workspace objects, so reordering or removing another
// workspace cannot restart a grace period or attach it to a different slot.
export class WorkspaceRetentionPolicy {
    constructor() {
        this.emptySince = new Map();
    }

    filled(workspace) {
        this.emptySince.delete(workspace);
    }

    clear() {
        this.emptySince.clear();
    }

    evaluate(workspaces, occupied, now, duration) {
        const present = new Set(workspaces);
        for (const workspace of this.emptySince.keys()) {
            if (!present.has(workspace) || occupied.has(workspace)) this.emptySince.delete(workspace);
        }
        if (duration <= 0) {
            this.clear();
            return {preserved: [], nextExpiry: null};
        }
        let lastOccupied = -1;
        workspaces.forEach((workspace, index) => {if (occupied.has(workspace)) lastOccupied = index;});
        const preserved = [];
        let nextExpiry = null;
        for (let index = 0; index < lastOccupied; index++) {
            const workspace = workspaces[index];
            if (occupied.has(workspace)) continue;
            if (!this.emptySince.has(workspace)) this.emptySince.set(workspace, now);
            const deadline = this.emptySince.get(workspace) + duration;
            if (now >= deadline) continue; // Stay expired until filled or removed.
            preserved.push(workspace);
            nextExpiry = nextExpiry === null ? deadline : Math.min(nextExpiry, deadline);
        }
        return {preserved, nextExpiry};
    }
}

// Never replace GNOME's real keep-alive source IDs or leave our marker behind,
// even if the native check throws. The marker exists only during this call.
export function withPreservedWorkspaces(workspaces, check) {
    const marker = Symbol('workspace-bar-retention'), saved = [];
    for (const workspace of workspaces) {
        if (workspace._keepAliveId) continue;
        saved.push([workspace, workspace._keepAliveId]);
        workspace._keepAliveId = marker;
    }
    try {return check();}
    finally {
        for (const [workspace, previous] of saved) {
            if (workspace._keepAliveId === marker) workspace._keepAliveId = previous;
        }
    }
}

// GNOME queues a bound check function. Replace pending checks when installing
// or removing the hook so a stale callback cannot bypass the current policy.
export function cancelQueuedWorkspaceCheck(tracker, laters) {
    if (!tracker._checkWorkspacesId) return;
    laters.remove(tracker._checkWorkspacesId);
    tracker._checkWorkspacesId = 0;
}
