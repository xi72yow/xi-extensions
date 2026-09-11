import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import Pango from 'gi://Pango'
import Shell from 'gi://Shell'
import St from 'gi://St'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'

import { ResultRow, SearchDialog } from './lib/searchDialog.js'
import { ClipboardHistory, ClipboardPicker } from './lib/clipboard.js'

const TOGGLE_PICKER = 'toggle-picker'
const OPEN_BROWSER = 'open-browser'
const OPEN_GIT = 'open-git'
const TOGGLE_CLIPBOARD = 'toggle-clipboard'
// the reserved workspace is stored alongside the projects, under a name no
// repository can carry
const HOME_KEY = '__home__'
const SENTINEL_BASE = 'https://xiws.invalid/open'
// moving a window while the workspace switch is still animating leaves the
// shell without a stacking record for it
const SETTLE_MS = 350
// three applications hitting the secret service at once has crashed
// gnome-keyring-daemon, and starting them together spikes the cpu
const STAGGER_MS = 700
const REFRESH_MS = 400
const SNAP_FADE_MS = 120
const SNAP_MOVE_MS = 160
const THUMB_WIDTH = 300
const THUMB_FALLBACK_RATIO = 16 / 10
// the session cards sit in a grid rather than a list, so a workspace is
// recognised by its thumbnail before its name is read
const SESSION_COLUMNS = 2
const PRESET_ICON_WIDTH = 64
const PRESET_ICON_HEIGHT = 32
// kept in sync with .xiws-card and .xiws-grid-row in the stylesheet, the
// dialog width is computed from them rather than stated in em: the cards are
// measured in pixels and an em width drifts against them with the font size
const CARD_PADDING = 8
const GRID_SPACING = 12
const SCROLLBAR_RESERVE = 16

function expandHome(path) {
  return path.startsWith('~') ? GLib.get_home_dir() + path.slice(1) : path
}

// a directory without .git is descended into, so repositories grouped under
// a folder are found as well. a repository is never descended into, which
// keeps submodules and vendored checkouts out of the list.
function scanForRepositories(base, prefix, depth, limit, exclude, found) {
  if (depth > limit) return

  let children
  try {
    children = Gio.File.new_for_path(base).enumerate_children(
      'standard::name,standard::type',
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
  } catch {
    return
  }

  let info
  while ((info = children.next_file(null)) !== null) {
    if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue

    const name = info.get_name()
    if (name.startsWith('.') || exclude.includes(name)) continue

    const path = GLib.build_filenamev([base, name])
    const label = prefix ? `${prefix}/${name}` : name

    if (GLib.file_test(GLib.build_filenamev([path, '.git']), GLib.FileTest.EXISTS)) {
      found.push({ name: label, path })
      continue
    }

    scanForRepositories(path, label, depth + 1, limit, exclude, found)
  }
}

function discoverWorkspaces(searchPaths, depth, exclude) {
  const found = []
  const limit = Math.max(depth, 1)

  for (const searchPath of searchPaths) {
    scanForRepositories(expandHome(searchPath), '', 1, limit, exclude, found)
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

// window classes differ in spelling between toolkits, github desktop for
// instance carries no StartupWMClass at all
function normalizeClass(value) {
  return (value || '').toLowerCase().replace(/[\s_-]/g, '')
}

function visibleWindows(workspace) {
  return workspace
    .list_windows()
    .filter((window) => !window.is_skip_taskbar() && !window.is_on_all_workspaces())
}

function isOccupied(workspace) {
  return visibleWindows(workspace).length > 0
}

function workspaceExists(workspace) {
  const manager = global.workspace_manager

  for (let index = 0; index < manager.get_n_workspaces(); index++) {
    if (manager.get_workspace_by_index(index) === workspace) return true
  }

  return false
}

function pickWorkspace(firstIndex) {
  const manager = global.workspace_manager

  for (let index = Math.max(firstIndex, 0); index < manager.get_n_workspaces(); index++) {
    const workspace = manager.get_workspace_by_index(index)
    if (workspace && !isOccupied(workspace)) return workspace
  }

  // appended without activating, mutter reclaims an empty workspace at the
  // end again, and the index then falls back to the last existing one
  manager.append_new_workspace(true, global.get_current_time())
  return manager.get_workspace_by_index(manager.get_n_workspaces() - 1)
}

function belongsToSession(window, desktopIds, classes) {
  const app = Shell.WindowTracker.get_default().get_window_app(window)
  if (app && desktopIds.includes(app.get_id())) return true

  if (classes.length === 0) return false

  const candidates = [
    normalizeClass(window.get_wm_class()),
    normalizeClass(window.get_wm_class_instance()),
  ]
  return classes.some((name) => candidates.includes(name))
}

function parseLayout(raw) {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    logError(error, 'xiws: session-layout is not valid json')
    return []
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function parseObject(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    logError(error, 'xiws: session-apps is not valid json')
    return {}
  }
}

// slots are fractions of the work area, so the same layout holds on any
// monitor size
function placeWindow(window, layout) {
  if (layout.length === 0) return

  const app = Shell.WindowTracker.get_default().get_window_app(window)
  if (!app) return

  const tile = layout.find((entry) => entry.app === app.get_id())
  if (!tile) return

  const sized = typeof tile.width === 'number' && typeof tile.height === 'number'
  const positioned = typeof tile.x === 'number' && typeof tile.y === 'number'
  if (!sized && !positioned && !tile.center) return

  const workspace = window.get_workspace()
  if (!workspace) return

  const area = workspace.get_work_area_for_monitor(window.get_monitor())
  if (!area || area.width === 0 || area.height === 0) return

  if (window.get_maximized()) window.unmaximize(Meta.MaximizeFlags.BOTH)

  // read the frame after unmaximizing, that is the size the window itself
  // remembers and which stays untouched without width and height
  const frame = window.get_frame_rect()
  const width = sized ? Math.round(tile.width * area.width) : frame.width
  const height = sized ? Math.round(tile.height * area.height) : frame.height

  const x = tile.center
    ? Math.round(area.x + (area.width - width) / 2)
    : Math.round(area.x + (tile.x ?? 0) * area.width)
  const y = tile.center
    ? Math.round(area.y + (area.height - height) / 2)
    : Math.round(area.y + (tile.y ?? 0) * area.height)

  if (sized) {
    window.move_resize_frame(false, x, y, width, height)
  } else {
    window.move_frame(false, x, y)
  }

  if (tile.background) window.lower()
}

function launch(commandline, workspaceIndex) {
  try {
    // the commandline is parsed as a desktop entry exec string, where a per
    // cent sign opens a field code. the %2F of an encoded workspace name was
    // read as the unknown code %2 and dropped, leaving a literal F behind and
    // turning trunshopdev/trunshop24 into trunshopdevFtrunshop24. nothing here
    // ever means a field code, so every per cent sign is escaped.
    const appInfo = Gio.AppInfo.create_from_commandline(
      commandline.replace(/%/g, '%%'),
      null,
      Gio.AppInfoCreateFlags.NONE,
    )
    appInfo.launch([], global.create_app_launch_context(0, workspaceIndex))
  } catch (error) {
    logError(error, `xiws: failed to launch ${commandline}`)
  }
}

// actor sizes are logical pixels while css lengths are multiplied by the
// theme scale factor, so the two parts of the sum are not in the same unit
function pickerWidth() {
  const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor
  const card = THUMB_WIDTH + 2 * CARD_PADDING * scale
  const gaps = (SESSION_COLUMNS - 1) * GRID_SPACING + SCROLLBAR_RESERVE

  return Math.round(SESSION_COLUMNS * card + gaps * scale)
}

// a card is only as wide as its thumbnail, so labels have to give way rather
// than stretch it
function ellipsized(text, styleClass) {
  const label = new St.Label({ text, style_class: styleClass })
  label.clutter_text.ellipsize = Pango.EllipsizeMode.END
  return label
}

function buildThumbnail(workspace) {
  const monitor = Main.layoutManager.primaryIndex
  const area = workspace.get_work_area_for_monitor(monitor)
  const usable = area && area.width > 0 && area.height > 0

  // the preview mirrors the aspect ratio of the work area, a fixed height
  // would leave most of an ultrawide thumbnail empty
  const height = usable
    ? Math.round((THUMB_WIDTH * area.height) / area.width)
    : Math.round(THUMB_WIDTH / THUMB_FALLBACK_RATIO)

  const container = new St.Widget({
    style_class: 'xiws-thumb',
    width: THUMB_WIDTH,
    height,
    clip_to_allocation: true,
  })

  if (!usable) return container

  const scale = THUMB_WIDTH / area.width
  const tracker = Shell.WindowTracker.get_default()

  for (const window of visibleWindows(workspace)) {
    const actor = window.get_compositor_private()
    const frame = window.get_frame_rect()

    if (actor) {
      container.add_child(
        new Clutter.Clone({
          source: actor,
          x: Math.round((frame.x - area.x) * scale),
          y: Math.round((frame.y - area.y) * scale),
          width: Math.round(frame.width * scale),
          height: Math.round(frame.height * scale),
        }),
      )
      continue
    }

    // a window without a compositor actor cannot be cloned, its application
    // icon still tells which one it is
    const app = tracker.get_window_app(window)
    if (!app) continue

    const icon = app.create_icon_texture(24)
    icon.set_position(
      Math.round((frame.x - area.x) * scale),
      Math.round((frame.y - area.y) * scale),
    )
    container.add_child(icon)
  }

  return container
}

function buildWindowPreview(window, width) {
  const frame = window.get_frame_rect()
  const ratio = frame.height > 0 ? frame.width / frame.height : THUMB_FALLBACK_RATIO
  const height = Math.round(width / ratio)

  const container = new St.Widget({
    style_class: 'xiws-preview',
    width,
    height,
    clip_to_allocation: true,
  })

  const actor = window.get_compositor_private()
  if (actor) {
    container.add_child(new Clutter.Clone({ source: actor, width, height }))
    return container
  }

  const app = Shell.WindowTracker.get_default().get_window_app(window)
  if (app) {
    const icon = app.create_icon_texture(64)
    icon.set_position(Math.round(width / 2 - 32), Math.round(height / 2 - 32))
    container.add_child(icon)
  }

  return container
}

const MODIFIER_MASKS = {
  control: Clutter.ModifierType.CONTROL_MASK,
  shift: Clutter.ModifierType.SHIFT_MASK,
  alt: Clutter.ModifierType.MOD1_MASK,
  super: Clutter.ModifierType.MOD4_MASK,
}

function readPresets(settings) {
  const presets = parseLayout(settings.get_string('snap-presets'))
  return presets.filter((preset) => Array.isArray(preset.tiles) && preset.tiles.length > 0)
}

function activeTiles(settings) {
  const presets = readPresets(settings)
  if (presets.length === 0) return []

  const index = Math.min(Math.max(settings.get_int('snap-preset'), 0), presets.length - 1)
  return presets[index].tiles
}

function buildPresetIcon(tiles, width, height) {
  const box = new St.Widget({ style_class: 'xiws-preset-icon', width, height })

  for (const tile of tiles) {
    box.add_child(
      new St.Widget({
        style_class: 'xiws-preset-tile',
        x: Math.round(tile.x * width),
        y: Math.round(tile.y * height),
        width: Math.max(Math.round(tile.width * width) - 2, 1),
        height: Math.max(Math.round(tile.height * height) - 2, 1),
      }),
    )
  }

  return box
}

function tileRect(tile, area) {
  return {
    x: Math.round(area.x + tile.x * area.width),
    y: Math.round(area.y + tile.y * area.height),
    width: Math.round(tile.width * area.width),
    height: Math.round(tile.height * area.height),
  }
}

function tileAt(tiles, area, pointerX, pointerY) {
  const x = (pointerX - area.x) / area.width
  const y = (pointerY - area.y) / area.height

  return (
    tiles.find(
      (tile) => x >= tile.x && x < tile.x + tile.width && y >= tile.y && y < tile.y + tile.height,
    ) ?? null
  )
}

// snapping while dragging needs the pointer position continuously, and the
// shell exposes no motion signal for that, so it is polled during the grab
class SnapAssist {
  constructor(settings) {
    this._settings = settings
    this._preview = null
    this._pollId = 0
    this._target = null
    this._window = null

    this._beginId = global.display.connect('grab-op-begin', (display, window, op) =>
      this._onGrabBegin(window, op),
    )
    this._endId = global.display.connect('grab-op-end', () => this._onGrabEnd())
  }

  destroy() {
    this._stopPolling()

    this._preview?.remove_all_transitions()
    this._preview?.destroy()
    this._preview = null
    this._window = null
    this._target = null

    if (this._beginId) global.display.disconnect(this._beginId)
    if (this._endId) global.display.disconnect(this._endId)
    this._beginId = 0
    this._endId = 0
  }

  _onGrabBegin(window, op) {
    if (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.KEYBOARD_MOVING) return
    if (!window || window.get_window_type() !== Meta.WindowType.NORMAL) return

    this._window = window
    this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
      this._poll()
      return GLib.SOURCE_CONTINUE
    })
  }

  _poll() {
    const mask = MODIFIER_MASKS[this._settings.get_string('snap-modifier')]
    const [pointerX, pointerY, mods] = global.get_pointer()

    if (!this._window || (mods & mask) === 0) {
      this._hide()
      return
    }

    const workspace = this._window.get_workspace()
    if (!workspace) return

    const area = workspace.get_work_area_for_monitor(this._window.get_monitor())
    if (!area || area.width === 0 || area.height === 0) return

    const tile = tileAt(activeTiles(this._settings), area, pointerX, pointerY)

    if (!tile) {
      this._hide()
      return
    }

    this._target = tileRect(tile, area)
    this._show(this._target)
  }

  _show(rect) {
    if (!this._preview) {
      this._preview = new St.Widget({
        style_class: 'tile-preview xiws-snap-preview',
      })
      Main.uiGroup.add_child(this._preview)
    }

    const animate = St.Settings.get().enable_animations
    this._preview.remove_all_transitions()

    // appearing is a fade in place, moving between zones glides, so the
    // preview reads as one object travelling rather than jumping around
    if (!this._preview.visible) {
      this._preview.set_position(rect.x, rect.y)
      this._preview.set_size(rect.width, rect.height)
      this._preview.opacity = animate ? 0 : 255
      this._preview.show()

      if (animate) {
        this._preview.ease({
          opacity: 255,
          duration: SNAP_FADE_MS,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        })
      }
      return
    }

    if (!animate) {
      this._preview.set_position(rect.x, rect.y)
      this._preview.set_size(rect.width, rect.height)
      return
    }

    this._preview.ease({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      opacity: 255,
      duration: SNAP_MOVE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    })
  }

  _hide() {
    this._target = null

    const preview = this._preview
    if (!preview?.visible) return

    preview.remove_all_transitions()

    if (!St.Settings.get().enable_animations) {
      preview.hide()
      return
    }

    preview.ease({
      opacity: 0,
      duration: SNAP_FADE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => preview.hide(),
    })
  }

  _onGrabEnd() {
    this._stopPolling()

    const window = this._window
    const target = this._target

    this._window = null
    this._hide()

    if (!window || !target) return

    if (window.get_maximized()) window.unmaximize(Meta.MaximizeFlags.BOTH)
    window.move_resize_frame(true, target.x, target.y, target.width, target.height)
  }

  _stopPolling() {
    if (this._pollId) {
      GLib.Source.remove(this._pollId)
      this._pollId = 0
    }
  }
}

const SessionDetail = GObject.registerClass(
  class SessionDetail extends ModalDialog.ModalDialog {
    _init(session) {
      super._init({ styleClass: 'xiws-detail', destroyOnClose: true })

      const monitor = Main.layoutManager.primaryMonitor
      const cardWidth = Math.round(Math.min(monitor.width * 0.22, 420))

      const header = new St.BoxLayout({ vertical: true, style_class: 'xiws-detail-header' })
      header.add_child(new St.Label({ text: session.name, style_class: 'xiws-detail-title' }))
      // the reserved workspace carries no project path
      const place = `Workspace ${session.workspace.index() + 1}`
      header.add_child(
        new St.Label({
          text: session.path ? `${session.path} · ${place}` : place,
          style_class: 'list-search-result-description',
        }),
      )
      this.contentLayout.add_child(header)

      const grid = new St.BoxLayout({ style_class: 'xiws-detail-grid' })
      const tracker = Shell.WindowTracker.get_default()

      for (const window of visibleWindows(session.workspace)) {
        const app = tracker.get_window_app(window)

        const card = new St.Button({
          style_class: 'list-search-result xiws-card',
          can_focus: true,
        })

        const box = new St.BoxLayout({ vertical: true, style_class: 'list-search-result-content' })
        box.add_child(buildWindowPreview(window, cardWidth))
        box.add_child(
          new St.Label({
            text: app ? app.get_name() : window.get_wm_class() || '',
            style_class: 'list-search-result-title',
          }),
        )
        box.add_child(
          new St.Label({
            text: window.get_title() || '',
            style_class: 'list-search-result-description',
          }),
        )

        card.set_child(box)
        card.connect('clicked', () => {
          this.close(global.get_current_time())
          Main.activateWindow(window, global.get_current_time())
        })

        grid.add_child(card)
      }

      const scroll = new St.ScrollView({
        style_class: 'xiws-detail-scroll',
        overlay_scrollbars: true,
        x_expand: true,
      })
      scroll.add_child(grid)
      this.contentLayout.add_child(scroll)
    }

    vfunc_key_press_event(event) {
      const symbol = event.get_key_symbol()

      if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_Left) {
        this.close(global.get_current_time())
        return Clutter.EVENT_STOP
      }

      return super.vfunc_key_press_event(event)
    }
  },
)

const SessionRow = GObject.registerClass(
  {
    Signals: { closed: {} },
  },
  class SessionRow extends St.Button {
    _init(session, { closable = true } = {}) {
      super._init({
        style_class: 'list-search-result xiws-card',
        can_focus: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
      })

      this.session = session
      this.closable = closable

      const box = new St.BoxLayout({ vertical: true, style_class: 'xiws-session-box' })

      // the close button sits on the thumbnail rather than next to the
      // labels. sharing a row with them, its width competed with their
      // minimum width, which pushed the card wider than its own thumbnail
      const head = new St.Widget({ layout_manager: new Clutter.BinLayout() })
      head.add_child(buildThumbnail(session.workspace))

      // a reactive child swallows the click before the surrounding button
      // sees it, so the card stays clickable as a whole
      if (closable) {
        // a bin layout centres whatever does not expand, so the alignment
        // only takes effect once the button fills the allocation
        const closeButton = new St.Button({
          style_class: 'icon-button xiws-card-close',
          child: new St.Icon({ icon_name: 'window-close-symbolic' }),
          x_expand: true,
          y_expand: true,
          x_align: Clutter.ActorAlign.END,
          y_align: Clutter.ActorAlign.START,
          can_focus: true,
        })
        closeButton.connect('clicked', () => this.emit('closed'))
        head.add_child(closeButton)
      }

      box.add_child(head)

      // pinned to the thumbnail width, otherwise a long project name would
      // widen the card and break the grid alignment
      const labels = new St.BoxLayout({
        vertical: true,
        width: THUMB_WIDTH,
        style_class: 'list-search-result-content',
      })
      labels.add_child(ellipsized(session.name, 'list-search-result-title'))
      labels.add_child(
        ellipsized(`Workspace ${session.workspace.index() + 1}`, 'list-search-result-description'),
      )

      box.add_child(labels)
      this.set_child(box)
    }

    vfunc_key_press_event(event) {
      if (this.closable && event.get_key_symbol() === Clutter.KEY_Delete) {
        this.emit('closed')
        return Clutter.EVENT_STOP
      }

      return super.vfunc_key_press_event(event)
    }
  },
)

const WorkspaceRow = GObject.registerClass(
  class WorkspaceRow extends ResultRow {
    _init(workspace) {
      super._init(workspace.name, workspace.path)
      this.workspace = workspace
    }
  },
)

const WorkspacePicker = GObject.registerClass(
  class WorkspacePicker extends SearchDialog {
    _init(settings) {
      super._init({ hint: 'Workspace' })

      this._settings = settings
      this._workspaces = []
      this._sessions = new Map()
      this._followedSession = null
      this._claimHandlerId = 0
      this._claims = []
      this._deferred = new Set()

      this._presetBar = new St.BoxLayout({ style_class: 'xiws-preset-bar', x_expand: true })
      this.contentLayout.add_child(this._presetBar)

      this.contentLayout.set_width(pickerWidth())
    }

    present() {
      // the scan costs milliseconds at depth three, so the dialog opens on
      // what is known and refreshes behind itself for the next time
      if (this._workspaces.length === 0) this._rescan()

      this._captureSessions()
      this._renderPresets()
      super.present()

      this._defer(REFRESH_MS, () => {
        this._rescan()
        if (this.state === ModalDialog.State.OPENED) this.render()
      })
    }

    _rescan() {
      this._workspaces = discoverWorkspaces(
        this._settings.get_strv('search-paths'),
        this._settings.get_int('search-depth'),
        this._settings.get_strv('search-exclude'),
      )
    }

    handleRowKey(row, symbol) {
      if (!row.session) return Clutter.EVENT_PROPAGATE

      if (row.closable && (symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_KP_Delete)) {
        this._closeSession(row.session)
        return Clutter.EVENT_STOP
      }

      if (symbol === Clutter.KEY_Right) {
        this._showDetail(row.session)
        return Clutter.EVENT_STOP
      }

      return Clutter.EVENT_PROPAGATE
    }

    _renderPresets() {
      this._presetBar.destroy_all_children()

      const presets = readPresets(this._settings)
      if (presets.length < 2) return

      const active = Math.min(
        Math.max(this._settings.get_int('snap-preset'), 0),
        presets.length - 1,
      )

      presets.forEach((preset, index) => {
        // expanding the slot while the button keeps its own size spreads the
        // presets evenly across the bar instead of bunching them on the left
        const button = new St.Button({
          style_class: 'xiws-preset',
          can_focus: true,
          toggle_mode: true,
          checked: index === active,
          x_expand: true,
          x_align: Clutter.ActorAlign.CENTER,
          child: buildPresetIcon(preset.tiles, PRESET_ICON_WIDTH, PRESET_ICON_HEIGHT),
        })

        button.connect('clicked', () => {
          this._settings.set_int('snap-preset', index)
          this._renderPresets()
        })

        this._presetBar.add_child(button)
      })
    }

    // capturing on open keeps the stored arrangement current without having
    // to watch every window for the whole lifetime of a session
    _captureSessions({ replace = false } = {}) {
      const stored = parseObject(this._settings.get_string('session-apps'))
      const configured = parseLayout(this._settings.get_string('session-layout'))
      const gitId = this._settings.get_string('git-desktop-id')
      const tracker = Shell.WindowTracker.get_default()
      const monitor = Main.layoutManager.primaryIndex
      let changed = false

      // the reserved workspace is captured too, so reopening it restores
      // what was there instead of a fixed set
      const home = this._homeWorkspace()
      const targets = home
        ? [{ name: HOME_KEY, workspace: home }, ...this._liveSessions()]
        : this._liveSessions()

      for (const session of targets) {
        const area = session.workspace.get_work_area_for_monitor(monitor)
        if (!area || area.width === 0 || area.height === 0) continue

        const windows = global.display.sort_windows_by_stacking(visibleWindows(session.workspace))

        const tiles = []
        const seen = new Set()

        windows.forEach((window, position) => {
          const app = tracker.get_window_app(window)
          if (!app) return

          // windows the shell cannot map to an installed application get a
          // synthetic app whose id only holds for this session
          if (app.is_window_backed()) return

          const id = app.get_id()
          if (seen.has(id)) return
          seen.add(id)

          // the git client follows sessions instead of belonging to one, so
          // capturing it would drop it from every session it is not on at
          // that moment, and it would never be started again
          if (id === gitId) return

          // an entry asking to be centred keeps its own size, so measuring
          // it would replace that intent with whatever it happens to be now
          const preset = configured.find((entry) => entry.app === id && entry.center)
          if (preset) {
            tiles.push(preset)
            return
          }

          const frame = window.get_frame_rect()
          tiles.push({
            app: id,
            x: round4((frame.x - area.x) / area.width),
            y: round4((frame.y - area.y) / area.height),
            width: round4(frame.width / area.width),
            height: round4(frame.height / area.height),
            background: position === 0 && windows.length > 1,
          })
        })

        if (tiles.length === 0) continue

        // merged rather than replaced: an application that happens to sit on
        // another workspace right now would otherwise drop out of the set,
        // and since the set drives the next launch it would never return.
        // the reserved workspace is the exception, it is never closed, so
        // capturing is the only moment its set can shrink at all. merging
        // there kept applications that were shut down long ago and started
        // them again on every open.
        const authoritative = replace || session.name === HOME_KEY
        const previous =
          authoritative || !Array.isArray(stored[session.name]) ? [] : stored[session.name]
        const kept = previous
          .map((tile) => (typeof tile === 'string' ? { app: tile } : tile))
          .filter((tile) => tile?.app && !seen.has(tile.app) && !tile.app.startsWith('window:'))

        stored[session.name] = [...tiles, ...kept]
        changed = true
      }

      if (changed) this._settings.set_string('session-apps', JSON.stringify(stored))
    }

    // an earlier format stored plain application ids without geometry
    _storedLayout(name) {
      const stored = parseObject(this._settings.get_string('session-apps'))
      const entry = stored[name]
      if (!Array.isArray(entry) || entry.length === 0) return null

      return entry
        .map((tile) => (typeof tile === 'string' ? { app: tile } : tile))
        .filter((tile) => tile && typeof tile.app === 'string')
    }

    // closing is the one moment the set is authoritative, so it replaces
    // instead of merging and an application can actually be dropped
    _closeSession(session) {
      this._captureSessions({ replace: true })

      const gitId = this._settings.get_string('git-desktop-id')
      const tracker = Shell.WindowTracker.get_default()
      const time = global.get_current_time()
      const parkIndex = this._homeIndex()

      // read before closing, the workspace may be gone afterwards
      const closedIndex = session.workspace.index()

      for (const window of visibleWindows(session.workspace)) {
        const app = tracker.get_window_app(window)

        // the git client is a single shared instance, closing it would take
        // it away from every other session as well
        if (app && app.get_id() === gitId) {
          window.change_workspace_by_index(parkIndex, false)
          continue
        }

        window.delete(time)
      }

      this._sessions.delete(session.name)
      this._focusAfterClose(closedIndex)
      this.render()
    }

    _homeIndex() {
      return Math.max(this._settings.get_int('first-workspace-index') - 1, 0)
    }

    _homeWorkspace() {
      return global.workspace_manager.get_workspace_by_index(this._homeIndex())
    }

    // the workspace below the session range carries no project, but it is
    // listed and drawn like any other session, it is simply always there
    _homeSession() {
      const workspace = this._homeWorkspace()
      if (!workspace) return null

      return { name: this._settings.get_string('home-label'), path: null, workspace }
    }

    // the reserved workspace is restored like a session, but nothing is
    // forced onto it: only what was there last time comes back, and only
    // what is not already running
    _openHome(workspace) {
      this.close(global.get_current_time())

      const index = this._homeIndex()
      workspace.activate(global.get_current_time())

      const stored = this._storedLayout(HOME_KEY)
      if (!stored) return

      const tracker = Shell.WindowTracker.get_default()
      const running = new Set()
      for (const window of visibleWindows(workspace)) {
        const app = tracker.get_window_app(window)
        if (app && !app.is_window_backed()) running.add(app.get_id())
      }

      const missing = stored.map((tile) => tile.app).filter((app) => !running.has(app))
      if (missing.length === 0) return

      this._claimWindows(workspace, stored, missing)
      this._runLaunchSteps(
        this._launchSteps(missing, {
          name: HOME_KEY,
          path: null,
          index,
          layout: stored,
          withGit: false,
        }),
      )
    }

    // leaving the emptied workspace behind, the way closing a tab moves on
    // to the next one
    _focusAfterClose(closedIndex) {
      const remaining = this._liveSessions()
      const next = remaining.find((session) => session.workspace.index() > closedIndex)
      const target = (next ?? remaining[0])?.workspace ?? this._homeWorkspace()

      target?.activate(global.get_current_time())
    }

    _liveSessions() {
      const live = []

      for (const [name, session] of this._sessions) {
        if (!workspaceExists(session.workspace) || !isOccupied(session.workspace)) {
          this._sessions.delete(name)
          continue
        }
        live.push(session)
      }

      return live.sort((a, b) => a.workspace.index() - b.workspace.index())
    }

    _recentWorkspaces() {
      const limit = Math.max(this._settings.get_int('recent-count'), 1)
      const order = this._settings.get_strv('recent-workspaces')
      const byName = new Map(this._workspaces.map((workspace) => [workspace.name, workspace]))

      const recent = order
        .map((name) => byName.get(name))
        .filter((workspace) => workspace !== undefined)
        .slice(0, limit)

      // nothing has been opened yet, an empty dialog would be useless
      return recent.length > 0 ? recent : this._workspaces.slice(0, limit)
    }

    _rememberWorkspace(name) {
      const order = this._settings.get_strv('recent-workspaces').filter((entry) => entry !== name)

      order.unshift(name)
      this._settings.set_strv('recent-workspaces', order.slice(0, 50))
    }

    render() {
      this.clearRows()

      const needle = this.needle
      const matches = (name) => name.toLowerCase().includes(needle)

      const home = this._homeSession()
      const showHome = home !== null && (!needle || matches(home.name))

      const sessions = this._liveSessions().filter((session) => !needle || matches(session.name))

      if (showHome || sessions.length > 0) {
        this.addHeading('Offene Sessions')

        if (showHome) {
          const row = new SessionRow(home, { closable: false })
          this.addRow(row, () => this._openHome(home.workspace), { columns: SESSION_COLUMNS })
        }

        for (const session of sessions) {
          const row = new SessionRow(session)
          row.connect('closed', () => this._closeSession(session))
          this.addRow(row, () => this._switchTo(session), { columns: SESSION_COLUMNS })
        }
      }

      const open = new Set(sessions.map((session) => session.name))
      const listed = needle
        ? this._workspaces.filter((workspace) => matches(workspace.name))
        : this._recentWorkspaces()

      const remaining = listed.filter((workspace) => !open.has(workspace.name))
      if (remaining.length === 0) return

      if (sessions.length > 0 || !needle) {
        this.addHeading(needle ? 'Projekte' : 'Zuletzt verwendet')
      }

      for (const workspace of remaining) {
        this.addRow(new WorkspaceRow(workspace), () => this._open(workspace))
      }
    }

    _showDetail(session) {
      this.close(global.get_current_time())
      new SessionDetail(session).open(global.get_current_time())
    }

    _defer(delay, callback) {
      const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        this._deferred.delete(id)
        callback()
        return GLib.SOURCE_REMOVE
      })

      this._deferred.add(id)
    }

    _cancelDeferred() {
      for (const id of this._deferred) GLib.Source.remove(id)
      this._deferred.clear()
    }

    _layoutFor(session) {
      return (
        this._storedLayout(session.name) ?? parseLayout(this._settings.get_string('session-layout'))
      )
    }

    _sessionForWorkspace(workspace) {
      for (const session of this._sessions.values()) {
        if (session.workspace === workspace) return session
      }

      return null
    }

    // reacting to the switch itself rather than to a shortcut covers every
    // way a workspace can be reached, including the overview and gestures
    onWorkspaceSwitched() {
      const active = global.workspace_manager.get_active_workspace()
      const session = this._sessionForWorkspace(active)

      if (!session) {
        this._followedSession = null
        return
      }

      if (this._followedSession === session.name) return
      this._followedSession = session.name

      const index = active.index()
      const layout = this._layoutFor(session)
      const app = Shell.AppSystem.get_default().lookup_app(
        this._settings.get_string('git-desktop-id'),
      )

      // a cold git client has no window yet, so it has to be caught as it
      // appears instead of being moved right away
      if (!app || app.state !== Shell.AppState.RUNNING) {
        this._claimWindows(active, layout, [this._settings.get_string('git-desktop-id')])
      }

      this._rememberWorkspace(session.name)
      this._defer(SETTLE_MS, () => this._followWithGit(session.path, index, layout))
    }

    // everything else is handled by onWorkspaceSwitched, which fires for
    // this activation as well
    _switchTo(session) {
      this.close(global.get_current_time())
      session.workspace.activate(global.get_current_time())
    }

    openAppInSession(desktopId) {
      const active = global.workspace_manager.get_active_workspace()
      const tracker = Shell.WindowTracker.get_default()

      const existing = visibleWindows(active).find((window) => {
        const app = tracker.get_window_app(window)
        return app && app.get_id() === desktopId
      })

      if (existing) {
        Main.activateWindow(existing, global.get_current_time())
        return
      }

      const session = this._sessionForWorkspace(active)
      const index = active.index()
      const layout = session ? this._layoutFor(session) : []

      this._claimWindows(active, layout, [desktopId])

      if (desktopId === this._settings.get_string('git-desktop-id')) {
        if (session) {
          this._followWithGit(session.path, index, layout)
        } else {
          launch('github-desktop', index)
        }
        return
      }

      const browser = this._settings.get_string('browser-command')

      // the reserved workspace holds no session yet carries tabs of its own,
      // any other workspace without one gets a plain window
      const name = session?.name ?? (index === this._homeIndex() ? HOME_KEY : null)
      if (!name) {
        launch(`${browser} --new-window`, index)
        return
      }

      const sentinel = `${SENTINEL_BASE}?ws=${encodeURIComponent(name)}`
      launch(`${browser} --new-window ${GLib.shell_quote(sentinel)}`, index)
    }

    // github desktop holds a single instance lock, so it cannot live on a
    // workspace, it switches repository and follows the session instead
    // the shipped github cli stubs out the linux path, the app itself still
    // handles --cli-open and forwards it through second-instance
    _followWithGit(path, targetIndex, layout) {
      launch(`github-desktop --cli-open=${GLib.shell_quote(path)}`, targetIndex)

      // the shell already knows which windows belong to an application, so
      // no window class has to be guessed here
      const app = Shell.AppSystem.get_default().lookup_app(
        this._settings.get_string('git-desktop-id'),
      )
      if (!app) return

      for (const window of app.get_windows()) {
        if (window.is_on_all_workspaces()) continue
        window.change_workspace_by_index(targetIndex, false)
        placeWindow(window, layout)
      }
    }

    // the reserved workspace carries its own browser window like any other,
    // so a cold browser needs no warm up round before the session window
    _open(workspace) {
      this.close(global.get_current_time())
      this._startSession(workspace)
    }

    _startSession(workspace) {
      const editorId = this._settings.get_string('editor-desktop-id')
      const browserId = this._settings.get_string('browser-desktop-id')
      const gitId = this._settings.get_string('git-desktop-id')

      // a previously captured arrangement wins over the configured default,
      // it carries both the applications and their geometry
      const stored = this._storedLayout(workspace.name)
      const layout = stored ?? parseLayout(this._settings.get_string('session-layout'))

      // editor, browser and git client make up a project session and are
      // always started. driving them from the captured set meant a session
      // lost one of them whenever it was not visible while capturing.
      // everything beyond them comes from what was captured.
      const captured = stored ? stored.map((tile) => tile.app) : []
      const wanted = [...new Set([editorId, browserId, ...captured])]

      const target = pickWorkspace(this._settings.get_int('first-workspace-index'))
      const index = target.index()

      // the git client is launched alongside without being part of the
      // captured set, so it has to be claimed for as well
      this._claimWindows(target, layout, [...wanted, gitId])
      target.activate(global.get_current_time())

      this._sessions.set(workspace.name, {
        name: workspace.name,
        path: workspace.path,
        workspace: target,
      })
      this._rememberWorkspace(workspace.name)

      // the git client is always included rather than driven by the captured
      // set, for the same reason it is skipped while capturing
      this._runLaunchSteps(
        this._launchSteps(wanted, { name: workspace.name, path: workspace.path, index, layout }),
      )
    }

    _launchSteps(wanted, { name, path, index, layout, withGit = true }) {
      const editorId = this._settings.get_string('editor-desktop-id')
      const browserId = this._settings.get_string('browser-desktop-id')
      const gitId = this._settings.get_string('git-desktop-id')

      const known = [editorId, browserId, gitId]
      const system = Shell.AppSystem.get_default()
      const steps = []

      if (wanted.includes(editorId)) {
        const editor = this._settings.get_string('editor-command')
        // without a project path the editor opens on its own
        const command = path ? `${editor} ${GLib.shell_quote(path)}` : editor
        steps.push(() => launch(command, index))
      }

      if (wanted.includes(browserId)) {
        const browser = this._settings.get_string('browser-command')
        const sentinel = `${SENTINEL_BASE}?ws=${encodeURIComponent(name)}`
        steps.push(() => launch(`${browser} --new-window ${GLib.shell_quote(sentinel)}`, index))
      }

      // a running instance only switches repository without creating a
      // window, so claiming on window-created would never see it either
      if (withGit) {
        steps.push(() => this._followWithGit(path, index, layout))
      } else if (wanted.includes(gitId)) {
        const app = system.lookup_app(gitId)
        if (app) steps.push(() => app.open_new_window(index))
      }

      // anything beyond the three known roles was picked up from a previous
      // session and just gets a window on the same workspace
      for (const id of wanted) {
        if (known.includes(id)) continue

        const app = system.lookup_app(id)
        if (app) steps.push(() => app.open_new_window(index))
      }

      return steps
    }

    // spaced out rather than started at once, see STAGGER_MS
    _runLaunchSteps(steps) {
      steps.forEach((step, position) => {
        this._defer(SETTLE_MS + position * STAGGER_MS, step)
      })
    }

    // several launches can be in flight at once: a session started while an
    // earlier one is still coming up, or a workspace switch arming the git
    // client. a single exclusive claim let the newer target take over the
    // windows of the older one, which is how a session ended up on the
    // reserved workspace. claims are therefore kept side by side, and a
    // window goes to the one that is still waiting for its application.
    // the workspace is held as an object rather than an index, indices shift
    // when dynamic workspaces are added or removed and a stale one silently
    // resolves to the last existing workspace
    _claimWindows(workspace, layout, apps) {
      const claim = { workspace, layout, apps: new Set(apps), timeoutId: 0 }

      const seconds = Math.max(this._settings.get_int('claim-seconds'), 1)
      claim.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        claim.timeoutId = 0
        this._dropClaim(claim)
        return GLib.SOURCE_REMOVE
      })

      this._claims.push(claim)

      // the launch context only carries a startup notification, which a
      // running instance ignores, so the windows are moved explicitly
      if (this._claimHandlerId) return

      this._claimHandlerId = global.display.connect('window-created', (display, window) => {
        const actor = window.get_compositor_private()
        if (!actor) return

        const frameId = actor.connect('first-frame', () => {
          actor.disconnect(frameId)
          this._claimWindow(window)
        })
      })
    }

    _claimWindow(window) {
      if (window.get_window_type() !== Meta.WindowType.NORMAL) return
      if (window.is_on_all_workspaces()) return

      const desktopIds = this._settings.get_strv('session-desktop-ids')
      const classes = this._settings.get_strv('claim-window-classes').map(normalizeClass)
      if (!belongsToSession(window, desktopIds, classes)) return

      const app = Shell.WindowTracker.get_default().get_window_app(window)
      const id = app ? app.get_id() : null

      // a window the shell cannot map was matched through its class alone, so
      // there is nothing to key on and the oldest claim takes it
      const claim = id ? this._claims.find((entry) => entry.apps.has(id)) : this._claims[0]
      if (!claim) return

      if (id) {
        claim.apps.delete(id)
        if (claim.apps.size === 0) this._dropClaim(claim)
      }

      // a window left where it is beats one moved onto the wrong workspace
      if (!workspaceExists(claim.workspace)) return

      window.change_workspace(claim.workspace)
      placeWindow(window, claim.layout)
    }

    _dropClaim(claim) {
      if (claim.timeoutId) {
        GLib.Source.remove(claim.timeoutId)
        claim.timeoutId = 0
      }

      const position = this._claims.indexOf(claim)
      if (position >= 0) this._claims.splice(position, 1)

      if (this._claims.length === 0) this._stopClaiming()
    }

    _stopClaiming() {
      for (const claim of this._claims) {
        if (claim.timeoutId) GLib.Source.remove(claim.timeoutId)
      }
      this._claims = []

      if (this._claimHandlerId) {
        global.display.disconnect(this._claimHandlerId)
        this._claimHandlerId = 0
      }
    }

    destroy() {
      this._stopClaiming()
      this._cancelDeferred()
      super.destroy()
    }
  },
)

export default class XiwsExtension extends Extension {
  enable() {
    this._settings = this.getSettings()
    this._picker = new WorkspacePicker(this._settings)

    this._bind(TOGGLE_PICKER, () => this._picker.toggle())
    this._bind(OPEN_BROWSER, () =>
      this._picker.openAppInSession(this._settings.get_string('browser-desktop-id')),
    )
    this._bind(OPEN_GIT, () =>
      this._picker.openAppInSession(this._settings.get_string('git-desktop-id')),
    )

    this._switchHandlerId = global.workspace_manager.connect('workspace-switched', () =>
      this._picker.onWorkspaceSwitched(),
    )

    this._snapAssist = new SnapAssist(this._settings)

    this._clipboard = new ClipboardHistory(this._settings)
    this._clipboardPicker = new ClipboardPicker(this._clipboard)
    this._bind(TOGGLE_CLIPBOARD, () => this._clipboardPicker.toggle())
  }

  _bind(name, callback) {
    Main.wm.addKeybinding(
      name,
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      callback,
    )
  }

  disable() {
    this._snapAssist?.destroy()
    this._snapAssist = null

    if (this._switchHandlerId) {
      global.workspace_manager.disconnect(this._switchHandlerId)
      this._switchHandlerId = 0
    }

    for (const name of [TOGGLE_PICKER, OPEN_BROWSER, OPEN_GIT, TOGGLE_CLIPBOARD]) {
      Main.wm.removeKeybinding(name)
    }

    this._clipboardPicker?.destroy()
    this._clipboardPicker = null
    this._clipboard?.destroy()
    this._clipboard = null

    this._picker?.destroy()
    this._picker = null
    this._settings = null
  }
}
