# Architecture

- [System overview](system-overview.md): component ownership, native storage, deployment boundaries.
- [Backend](backend.md): HTTP responsibilities, windows/cursors, runtime truth, same-instance controls.
- [Frontend](frontend.md): the compact interface, on-demand bodies, single-flight refresh, mobile viewport.
- [Core data flow](data-flow.md): opening, receiving updates, and replying.
- [E2E testing](../dev/e2e-testing.md): isolated production-bundle verification across seven device/browser projects.

Current product decisions are tracked in [Issue #1](https://github.com/stoneedle/pi-web/issues/1). There is one interface and one native execution owner per session; removed workspace features have no alternate runtime or compatibility renderer.
