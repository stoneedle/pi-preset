import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { request } from './remote-api.js';

// Tab-local operations survive navigation between the home list and the drawer.
export const sessionArchives = $state({
  hidden: new SvelteMap(),
  restored: new SvelteMap(),
  projects: new SvelteMap(),
  projectBarriers: new SvelteMap(),
  pendingProjects: new SvelteSet(),
  pending: new SvelteSet(),
  batchPending: false,
  errors: new SvelteMap(),
  revision: 0,
});

export async function setSessionArchived(session, archived) {
  if (
    sessionArchives.batchPending ||
    sessionArchives.pending.has(session.id) ||
    sessionArchives.pendingProjects.has(session.project)
  )
    return false;
  sessionArchives.pending.add(session.id);
  sessionArchives.errors.delete(session.id);
  const previous = sessionArchives.hidden.get(session.id);
  if (archived) sessionArchives.hidden.set(session.id, Infinity);
  try {
    await request('/api/session/archive?id=' + encodeURIComponent(session.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    const revision = ++sessionArchives.revision;
    if (archived) {
      sessionArchives.hidden.set(session.id, revision);
      sessionArchives.restored.delete(session.id);
    } else {
      sessionArchives.hidden.delete(session.id);
      sessionArchives.restored.set(session.id, revision);
      sessionArchives.projects.delete(session.project);
    }
    return true;
  } catch (error) {
    if (previous === undefined) sessionArchives.hidden.delete(session.id);
    else sessionArchives.hidden.set(session.id, previous);
    sessionArchives.errors.set(session.id, { name: session.name, message: error.message });
    return false;
  } finally {
    sessionArchives.pending.delete(session.id);
  }
}

export async function archiveDisconnected(project) {
  if (
    sessionArchives.batchPending ||
    sessionArchives.pending.size ||
    sessionArchives.pendingProjects.size
  )
    return false;
  sessionArchives.batchPending = true;
  const key = project ? 'disconnected:' + project.path : 'disconnected:all';
  sessionArchives.errors.delete(key);
  try {
    const reply = await request('/api/sessions/archive-disconnected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project ? { project: project.path } : {}),
    });
    const revision = ++sessionArchives.revision;
    // Hide only IDs accepted by the server: a previously disconnected Pi may have reconnected.
    for (const id of reply.ids) {
      sessionArchives.hidden.set(id, revision);
      sessionArchives.restored.delete(id);
    }
    return true;
  } catch (error) {
    sessionArchives.errors.set(key, {
      name: project?.name || '全部会话',
      message: error.message,
    });
    return false;
  } finally {
    sessionArchives.batchPending = false;
  }
}

export function observeSessions(items, readRevision, archived) {
  const changes = archived ? sessionArchives.restored : sessionArchives.hidden;
  for (const session of items) {
    // Only a read begun after acceptance can establish a later external operation.
    if (changes.get(session.id) <= readRevision) changes.delete(session.id);
  }
}

export function sessionHidden(session, archived) {
  if (archived) return sessionArchives.restored.has(session.id);
  return (
    sessionArchives.hidden.has(session.id) ||
    (session.archiveRevision ?? -1) < (sessionArchives.projectBarriers.get(session.project) ?? -1)
  );
}

export function observeProjects(projects, readRevision) {
  for (const project of projects) {
    if (sessionArchives.projects.get(project.path) <= readRevision)
      sessionArchives.projects.delete(project.path);
  }
}

export async function archiveProject(project) {
  const path = project.path;
  if (sessionArchives.batchPending || sessionArchives.pendingProjects.has(path)) return false;
  sessionArchives.pendingProjects.add(path);
  const key = 'project:' + path;
  sessionArchives.errors.delete(key);
  const previous = sessionArchives.projects.get(path);
  const barrier = sessionArchives.projectBarriers.get(path);
  sessionArchives.projects.set(path, Infinity);
  sessionArchives.projectBarriers.set(path, Infinity);
  try {
    await request('/api/project/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: path }),
    });
    const revision = ++sessionArchives.revision;
    sessionArchives.projects.set(path, revision);
    sessionArchives.projectBarriers.set(path, revision);
    return true;
  } catch (error) {
    if (previous === undefined) sessionArchives.projects.delete(path);
    else sessionArchives.projects.set(path, previous);
    if (barrier === undefined) sessionArchives.projectBarriers.delete(path);
    else sessionArchives.projectBarriers.set(path, barrier);
    sessionArchives.errors.set(key, { name: project.name, message: error.message });
    return false;
  } finally {
    sessionArchives.pendingProjects.delete(path);
  }
}
