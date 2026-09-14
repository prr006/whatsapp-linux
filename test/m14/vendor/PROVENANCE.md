# Vendored GNOME Shell 50.1 sources (M14 test evidence)

`gnome-shell-50.1/messageTray.js` is a **verbatim** copy of
`js/ui/messageTray.js` from the upstream GNOME Shell repository at tag
`50.1` (the exact version the target desktop runs: GNOME Shell 50.1,
Ubuntu, Wayland).

- Upstream URL (GitHub mirror of gitlab.gnome.org/GNOME/gnome-shell):
  https://github.com/GNOME/gnome-shell/blob/50.1/js/ui/messageTray.js
- Fetched: 2026-09-14 via the GitHub contents API (`ref=50.1`).
- MD5: `7ba22e95b5e0c4027a9585567e1bde0b`

It is included in the test suite so that the M14 simulation tests execute
the **real, unmodified 50.1 banner state machine** under Node (with only
the GI/GTK display layer stubbed — see `../stubs/`), instead of a
re-implementation. The stock-behaviour scenarios in
`test/m14-gnome501-simulation.test.js` first reproduce the documented
real-world behavior (active ~4.2 s expiry; idle = never until activity;
pointer drift re-arms +1 s) to validate the harness before asserting the
governor's deterministic behavior on the same code.

The other files in this directory (`main.js`, `layout.js`,
`messageList.js`, `misc/*`) are minimal stand-ins for modules the vendored
file imports; they provide only the surface `messageTray.js` touches and
are marked as such in-file. `gnome-shell-50.1/injectionManager.js` is the
`InjectionManager` class extracted verbatim (minus its GJS
`imports._gi` binding) from the 50.1 `js/extensions/extension.js` — the
shell's supported extension override API that the shipped extension uses.
