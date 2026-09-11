const SENTINEL_HOST = 'xiws.invalid'
const STORABLE_SCHEMES = ['http:', 'https:', 'file:']
const SNAPSHOT_DELAY_MS = 400
const BOOKMARK_ROOT = 'xiws'
const OTHER_BOOKMARKS_ID = '2'
// the reserved workspace is keyed under a name no repository can carry, which
// would show up verbatim in the bookmark manager
const HOME_WORKSPACE = '__home__'
const HOME_FOLDER = 'Persönlich'
const SWEEP_ALARM = 'xiws-sweep'
const SWEEP_MINUTES = 5

const handledSentinels = new Set()
const pendingSnapshots = new Map()

const stateKey = (workspace) => `state:${workspace}`

function parseSentinel(rawUrl) {
  if (!rawUrl) return null

  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.hostname !== SENTINEL_HOST) return null

  const workspace = url.searchParams.get('ws')
  if (!workspace) return null

  return { workspace, presets: url.searchParams.getAll('url') }
}

function isStorable(rawUrl) {
  if (!rawUrl) return false

  try {
    return STORABLE_SCHEMES.includes(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

async function readBindings() {
  const { bindings = {} } = await chrome.storage.session.get('bindings')
  return bindings
}

async function bindWindow(windowId, workspace) {
  const bindings = await readBindings()
  bindings[windowId] = workspace
  await chrome.storage.session.set({ bindings })
}

async function unbindWindow(windowId) {
  const bindings = await readBindings()
  delete bindings[windowId]
  await chrome.storage.session.set({ bindings })
}

async function workspaceOf(windowId) {
  return (await readBindings())[windowId] ?? null
}

// bookmarks are the durable copy: chrome carries them into the account and
// the bookmark manager can export them, neither of which storage.sync can
// do for this amount of data
async function findFolder(title, parentId) {
  const children = await chrome.bookmarks.getChildren(parentId)
  return children.find((child) => !child.url && child.title === title) ?? null
}

async function ensureFolder(title, parentId) {
  const existing = await findFolder(title, parentId)
  if (existing) return existing.id

  const created = await chrome.bookmarks.create({ parentId, title })
  return created.id
}

// chrome numbers its roots 1 bookmarks bar, 2 other, 3 mobile. taking the
// last child as a fallback landed the folder under mobile bookmarks, so the
// second position is the better guess when the id lookup comes up empty.
async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree()
  const children = (root.children ?? []).filter((child) => !child.url)
  if (children.length === 0) return root.id

  const byId = children.find((child) => child.id === OTHER_BOOKMARKS_ID)
  return (byId ?? children[1] ?? children[0]).id
}

async function workspaceFolder(workspace, { create }) {
  const parentId = await otherBookmarksId()

  const rootId = create
    ? await ensureFolder(BOOKMARK_ROOT, parentId)
    : (await findFolder(BOOKMARK_ROOT, parentId))?.id
  if (!rootId) return null

  const title = workspace === HOME_WORKSPACE ? HOME_FOLDER : workspace

  return create
    ? await ensureFolder(title, rootId)
    : ((await findFolder(title, rootId))?.id ?? null)
}

async function writeBookmarks(workspace) {
  const key = stateKey(workspace)
  const stored = (await chrome.storage.local.get(key))[key]
  const entries = stored?.tabs ?? []
  if (entries.length === 0) return

  const folderId = await workspaceFolder(workspace, { create: true })
  if (!folderId) return

  const existing = await chrome.bookmarks.getChildren(folderId)

  // rewriting an unchanged folder would produce sync traffic for nothing
  const unchanged =
    existing.length === entries.length &&
    existing.every((child, index) => child.url === entries[index].url)
  if (unchanged) return

  for (const child of existing) {
    await chrome.bookmarks.remove(child.id)
  }

  for (const entry of entries) {
    await chrome.bookmarks.create({
      parentId: folderId,
      title: entry.title || entry.url,
      url: entry.url,
    })
  }
}

async function readBookmarks(workspace) {
  const folderId = await workspaceFolder(workspace, { create: false })
  if (!folderId) return null

  const children = await chrome.bookmarks.getChildren(folderId)
  const tabs = children
    .filter((child) => isStorable(child.url))
    .map((child) => ({ url: child.url, title: child.title }))

  return tabs.length > 0 ? { tabs } : null
}

// the local copy is authoritative while a workspace lives on this machine,
// bookmarks carry it across machines and into backups
async function readState(workspace) {
  const key = stateKey(workspace)
  const local = (await chrome.storage.local.get(key))[key]
  if (local?.tabs?.length) return local

  return await readBookmarks(workspace)
}

async function restore(sentinel, sentinelTab) {
  const { windowId, id: sentinelTabId } = sentinelTab
  const stored = await readState(sentinel.workspace)

  const entries = stored?.tabs?.length ? stored.tabs : sentinel.presets.map((url) => ({ url }))

  await bindWindow(windowId, sentinel.workspace)

  const created = []

  if (entries.length === 0) {
    await chrome.tabs.create({ windowId, active: true })
  } else {
    for (const entry of entries) {
      created.push(
        await chrome.tabs.create({
          windowId,
          url: entry.url,
          active: false,
        }),
      )
    }
  }

  await chrome.tabs.remove(sentinelTabId)

  for (const tab of created) discardWhenLoaded(tab.id)
}

// discarding a tab that is still loading leaves it stuck on about:blank,
// because there is no completed state to return to. waiting for the load to
// finish keeps title and favicon and only frees the memory behind them.
function discardWhenLoaded(tabId) {
  const done = (id, changeInfo) => {
    if (id !== tabId || changeInfo.status !== 'complete') return

    chrome.tabs.onUpdated.removeListener(done)
    chrome.tabs.onRemoved.removeListener(gone)

    // the active tab cannot be discarded, which is the intended outcome
    chrome.tabs.discard(tabId).catch(() => {})
  }

  const gone = (id) => {
    if (id !== tabId) return
    chrome.tabs.onUpdated.removeListener(done)
    chrome.tabs.onRemoved.removeListener(gone)
  }

  chrome.tabs.onUpdated.addListener(done)
  chrome.tabs.onRemoved.addListener(gone)
}

async function snapshot(windowId) {
  const workspace = await workspaceOf(windowId)
  if (!workspace) return

  let tabs
  try {
    tabs = await chrome.tabs.query({ windowId })
  } catch {
    return
  }

  // a live window always has at least one tab, an empty result means the
  // window went away between scheduling and running
  if (tabs.length === 0) return

  const entries = tabs
    .map((tab) => ({ url: tab.url || tab.pendingUrl, title: tab.title }))
    .filter((entry) => isStorable(entry.url))

  await chrome.storage.local.set({
    [stateKey(workspace)]: { tabs: entries, savedAt: Date.now() },
  })
}

function scheduleSnapshot(windowId) {
  clearTimeout(pendingSnapshots.get(windowId))

  pendingSnapshots.set(
    windowId,
    setTimeout(() => {
      pendingSnapshots.delete(windowId)
      snapshot(windowId)
    }, SNAPSHOT_DELAY_MS),
  )
}

function cancelSnapshot(windowId) {
  clearTimeout(pendingSnapshots.get(windowId))
  pendingSnapshots.delete(windowId)
}

async function handleSentinel(sentinel, tab) {
  if (handledSentinels.has(tab.id)) return

  handledSentinels.add(tab.id)
  try {
    await restore(sentinel, tab)
  } finally {
    handledSentinels.delete(tab.id)
  }
}

// closing a window is the moment the durable copy is written. a crash or a
// browser shutdown can skip that, so a periodic sweep covers the gap. both
// are no-ops when nothing changed.
async function sweep() {
  const bindings = await readBindings()
  for (const workspace of new Set(Object.values(bindings))) {
    await writeBookmarks(workspace)
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const sentinel = parseSentinel(tab.pendingUrl || tab.url)
  if (sentinel) {
    handleSentinel(sentinel, tab)
    return
  }

  scheduleSnapshot(tab.windowId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const sentinel = parseSentinel(changeInfo.url)
  if (sentinel) {
    handleSentinel(sentinel, tab)
    return
  }

  if (changeInfo.url || changeInfo.title) {
    scheduleSnapshot(tab.windowId)
  }
})

// window teardown removes every tab one by one, snapshotting that would
// shrink the stored state down to nothing
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) return

  scheduleSnapshot(removeInfo.windowId)
})

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  scheduleSnapshot(moveInfo.windowId)
})

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  scheduleSnapshot(attachInfo.newWindowId)
})

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  scheduleSnapshot(detachInfo.oldWindowId)
})

// a pending snapshot must not outlive its window, it would query a gone
// window and overwrite the state that was valid right before the close
chrome.windows.onRemoved.addListener(async (windowId) => {
  cancelSnapshot(windowId)

  const workspace = await workspaceOf(windowId)
  await unbindWindow(windowId)

  if (workspace) await writeBookmarks(workspace)
})

chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_MINUTES })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sweep()
})
