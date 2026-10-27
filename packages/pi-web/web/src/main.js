import { mount } from 'svelte';
import RemoteRouter from './RemoteRouter.svelte';
import { startRefreshProtection } from './remote-refresh.svelte.js';
import { registerWorker } from './remote-worker.js';
import { startDiagnostics } from './remote-diagnostics.js';

startDiagnostics();
mount(RemoteRouter, { target: document.getElementById('spa-root') });
startRefreshProtection();
registerWorker();
