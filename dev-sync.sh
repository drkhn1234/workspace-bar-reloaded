#!/usr/bin/env bash
# Sync this canonical repo into a SEPARATE dev-UUID extension install (real dir,
# never a symlink) so GNOME's auto-update/uninstall of the published UUID can
# never touch this repo. Run after edits, then reload the shell / enable the dev ext.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEV_UUID="workspace-bar-reloaded-dev@drkhn1234.github.io"
DEST="$HOME/.local/share/gnome-shell/extensions/$DEV_UUID"
rm -rf "$DEST"; mkdir -p "$DEST/schemas"
cp "$SRC"/*.js "$SRC"/stylesheet.css "$SRC"/LICENSE "$SRC"/README.md "$DEST"/
cp "$SRC"/schemas/*.gschema.xml "$DEST/schemas/"
python3 - "$SRC/metadata.json" "$DEST/metadata.json" "$DEV_UUID" <<'PY'
import json,sys
src,dst,uuid=sys.argv[1:4]
d=json.load(open(src)); d['uuid']=uuid; d['name']=d.get('name','Workspace Bar: Reloaded')+' (dev)'
json.dump(d,open(dst,'w'),indent=2,ensure_ascii=False); open(dst,'a').write('\n')
PY
glib-compile-schemas "$DEST/schemas/"
echo "synced canonical ($(git -C "$SRC" rev-parse --short HEAD)) -> $DEST (uuid=$DEV_UUID)"
