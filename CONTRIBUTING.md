# Development

### Settings reference

Every preference is a GSettings key in `schemas/org.gnome.shell.extensions.workspace-bar.gschema.xml`,
read through a getter on the extension object and applied by the hook listed here. Anything not marked
"live" is read at the moment it is needed, so it needs no `changed::` wiring.

| Preferences UI | Group | Key | Default | Applied by |
| --- | --- | --- | --- | --- |
| Position | Position | `position` | `center` | `onPositionChanged()` (live) |
| Position In Box | Position | `position-index` | `0` | `onPositionChanged()` (live) |
| Size | Appearance | `size-mode` | `large` | CSS regeneration + `onSizeModeChanged()` (live) |
| Hover Magnification | Magnification | `enable-magnification` | `true` | `onMagnificationSettingsChanged()` (live) |
| Magnification preset | Magnification | `magnification-active-preset`, `magnification-custom-presets` | Default, no saved custom entries | applies curve and app-spacing keys; custom edits are saved |
| Workspace Group Gap | Magnification | `magnification-spacing` | `16` | `onMagnificationSettingsChanged()` (live) |
| Active Workspace Circle | Magnification | `show-active-workspace-ring` | `true` | `onMagnificationSettingsChanged()` (live, magnified view only) |
| Advanced Settings | Magnification | `show-advanced-magnification` | `true` | shows/hides advanced controls |
| Peak Size / Compression / Cutoff / Group Gap / Circle | Magnification page | `magnification-peak-mode`, `magnification-scale`, `magnification-peak-pixels`, `magnification-compression`, `magnification-cutoff-distance`, `magnification-spacing`, `show-active-workspace-ring` | relative 250%, c = 1, cutoff 96 logical px | live layout / canvas rebuild |
| Advanced magnification controls | Four advanced groups | see `magnificationSettings.js` | current appearance | live layout, proxy rebuild or CSS regeneration as needed |
| Show Icons Background | Appearance | `show-icons-background` | `true` | CSS regeneration (live) |
| Legibility Shadows | Appearance | `legibility-shadows` | `true` | `onLegibilityShadowsChanged()` (live) |
| Dim Inactive Icons | Appearance | `dim-inactive-icons` | `true` | `onIconEffectsChanged()` (live) |
| Desaturate Inactive Icons | Appearance | `desaturate-inactive-icons` | `false` | `onIconEffectsChanged()` (live) |
| Enable Animations | Animation | `enable-animations` | `true` | read at animation time |
| Focus Scale Effect | Animation | `focus-scale-effect` | `true` | `onIconEffectsChanged()` (live) |
| Reduction Amount | Animation | `focus-scale-reduction` | `15` | `onIconEffectsChanged()` (live) |
| Combine App Icons | Behaviour | `combine-icons` | `false` | `onCombineIconsChanged()` (live) |
| Empty Workspace Cooldown | Behaviour | `empty-workspace-cooldown` | `5` seconds | retention deadline and GNOME tracker check (live) |
| Click and scroll actions | Gestures | `gesture-horizontal-switch-workspaces`, `gesture-app-*`, `gesture-workspace-*` | app middle opens a new instance; up moves to active, down closes, horizontal switches workspaces with natural touchpad direction | read at gesture time |

Factory defaults follow the selected profile in `defaultConfiguration.js`, including centered placement,
Large size, animations, dimming and appearance tuning. Schema defaults and magnification section resets
are verified against that profile. Migration bookkeeping and saved preset history are excluded.
The old middle-click setting is retained only for migration. Every setting
that depends on window focus (scale, dim, desaturation) shares the single `onIconEffectsChanged()`
invalidation point, which walks the icons through `_applyIconEffects()`; adding a fourth focus-dependent
effect means extending that function, not adding another `notify::focus-window` listener.

### Adding a setting

1. Add the key to the schema, with a default that keeps current behaviour.
2. Add a getter on `WorkspaceBarExtension` in `extension.js`, next to the others.
3. If it must apply live, connect `changed::<key>` in `enable()` to the matching hook on the bar.
4. Add a row in `prefs.js` with `addSwitchRow`, `addSpinRow` or `addComboRow`, in the group it belongs to.
   For a row that only matters while another switch is on, wire it with `bindRowToSwitch`.
5. Add a line to the table above.

### Testing a change

Run the layout and magnification checks with `node --test tests/*.test.mjs`.
After compiling schemas, verify factory settings and migrations with
`GSETTINGS_BACKEND=memory gjs -m tests/defaults-check.mjs`.

For the preferences workflow and rendered preview check, compile the schema and run:

```bash
glib-compile-schemas --strict schemas
GI_TYPELIB_PATH=/usr/lib/gnome-shell/girepository-1.0 LD_LIBRARY_PATH=/usr/lib/gnome-shell \
  GSETTINGS_BACKEND=memory GSK_RENDERER=cairo gjs -m tests/preferences-check.mjs
```

This uses an isolated memory backend, so it does not change desktop preferences. Set
`WSB_PREFERENCES_SCREENSHOT=/tmp/workspace-bar-prefs.png` to save rendered artifacts.

When updating an active extension installation, replace `schemas/gschemas.compiled`
atomically using a temporary file and rename. GNOME memory-maps this file; overwriting
it in place can invalidate schemas held by the running shell and terminate the session.

`./dev-sync.sh` copies the working tree into a separate `workspace-bar-reloaded-dev@drkhn1234.github.io` install with its own
UUID, so the published extension is never touched by development and GNOME's auto-update can never
overwrite the repository. Reload the shell and enable the dev UUID to run it.

