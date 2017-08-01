/** @babel */

import fs from 'fs'
import path from 'path'

import {Emitter, Disposable, CompositeDisposable} from 'event-kit'
import nsfw from 'nsfw'

import NativeWatcherRegistry from './native-watcher-registry'

// Private: Associate native watcher action type flags with descriptive String equivalents.
const ACTION_MAP = new Map([
  [nsfw.actions.MODIFIED, 'changed'],
  [nsfw.actions.CREATED, 'added'],
  [nsfw.actions.DELETED, 'deleted'],
  [nsfw.actions.RENAMED, 'renamed']
])

// Private: Possible states of a {NativeWatcher}.
export const WATCHER_STATE = {
  STOPPED: Symbol('stopped'),
  STARTING: Symbol('starting'),
  RUNNING: Symbol('running'),
  STOPPING: Symbol('stopping')
}

// Private: Interface with and normalize events from a native OS filesystem watcher.
class NativeWatcher {

  // Private: Initialize a native watcher on a path.
  //
  // Events will not be produced until {start()} is called.
  constructor (normalizedPath) {
    this.normalizedPath = normalizedPath
    this.emitter = new Emitter()

    this.watcher = null
    this.state = WATCHER_STATE.STOPPED
  }

  // Private: Begin watching for filesystem events.
  //
  // Has no effect if the watcher has already been started.
  async start () {
    if (this.state !== WATCHER_STATE.STOPPED) {
      return
    }
    this.state = WATCHER_STATE.STARTING

    this.watcher = await nsfw(
      this.normalizedPath,
      this.onEvents.bind(this),
      {
        debounceMS: 100,
        errorCallback: this.onError.bind(this)
      }
    )

    await this.watcher.start()

    this.state = WATCHER_STATE.RUNNING
    this.emitter.emit('did-start')
  }

  // Private: Return true if the underlying watcher is actively listening for filesystem events.
  isRunning () {
    return this.state === WATCHER_STATE.RUNNING
  }

  // Private: Register a callback to be invoked when the filesystem watcher has been initialized.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onDidStart (callback) {
    return this.emitter.on('did-start', callback)
  }

  // Private: Register a callback to be invoked with normalized filesystem events as they arrive. Starts the watcher
  // automatically if it is not already running. The watcher will be stopped automatically when all subscribers
  // dispose their subscriptions.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onDidChange (callback) {
    this.start()

    const sub = this.emitter.on('did-change', callback)
    return new Disposable(() => {
      sub.dispose()
      if (this.emitter.listenerCountForEventName('did-change') === 0) {
        this.stop()
      }
    })
  }

  // Private: Register a callback to be invoked when a {Watcher} should attach to a different {NativeWatcher}.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onShouldDetach (callback) {
    return this.emitter.on('should-detach', callback)
  }

  // Private: Register a callback to be invoked when a {NativeWatcher} is about to be stopped.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onWillStop (callback) {
    return this.emitter.on('will-stop', callback)
  }

  // Private: Register a callback to be invoked when the filesystem watcher has been stopped.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onDidStop (callback) {
    return this.emitter.on('did-stop', callback)
  }

  // Private: Register a callback to be invoked with any errors reported from the watcher.
  //
  // Returns: A {Disposable} to revoke the subscription.
  onDidError (callback) {
    return this.emitter.on('did-error', callback)
  }

  // Private: Broadcast an `onShouldDetach` event to prompt any {Watcher} instances bound here to attach to a new
  // {NativeWatcher} instead.
  //
  // * `replacement` the new {NativeWatcher} instance that a live {Watcher} instance should reattach to instead.
  // * `watchedPath` absolute path watched by the new {NativeWatcher}.
  reattachTo (replacement, watchedPath) {
    this.emitter.emit('should-detach', {replacement, watchedPath})
  }

  // Private: Stop the native watcher and release any operating system resources associated with it.
  //
  // Has no effect if the watcher is not running.
  async stop () {
    if (this.state !== WATCHER_STATE.RUNNING) {
      return
    }
    this.state = WATCHER_STATE.STOPPING
    this.emitter.emit('will-stop')

    await this.watcher.stop()
    this.state = WATCHER_STATE.STOPPED

    this.emitter.emit('did-stop')
  }

  // Private: Detach any event subscribers.
  dispose () {
    this.emitter.dispose()
  }

  // Private: Callback function invoked by the native watcher when a debounced group of filesystem events arrive.
  // Normalize and re-broadcast them to any subscribers.
  //
  // * `events` An Array of filesystem events.
  onEvents (events) {
    this.emitter.emit('did-change', events.map(event => {
      const type = ACTION_MAP.get(event.action) || `unexpected (${event.action})`
      const oldFileName = event.file || event.oldFile
      const newFileName = event.newFile
      const oldPath = path.join(event.directory, oldFileName)
      const newPath = newFileName && path.join(event.directory, newFileName)

      return {oldPath, newPath, type}
    }))
  }

  // Private: Callback function invoked by the native watcher when an error occurs.
  //
  // * `err` The native filesystem error.
  onError (err) {
    this.emitter.emit('did-error', err)
  }
}

export class PathWatcher {
  constructor (nativeWatcherRegistry, watchedPath, options) {
    this.watchedPath = watchedPath
    this.nativeWatcherRegistry = nativeWatcherRegistry

    this.normalizedPath = null
    this.native = null
    this.changeCallbacks = new Map()

    this.normalizedPathPromise = new Promise((resolve, reject) => {
      fs.realpath(watchedPath, (err, real) => {
        if (err) {
          reject(err)
          return
        }

        this.normalizedPath = real
        resolve(real)
      })
    })

    this.attachedPromise = new Promise(resolve => {
      this.resolveAttachedPromise = resolve
    })
    this.startPromise = new Promise(resolve => {
      this.resolveStartPromise = resolve
    })

    this.emitter = new Emitter()
    this.subs = new CompositeDisposable()
  }

  getNormalizedPathPromise () {
    return this.normalizedPathPromise
  }

  getAttachedPromise () {
    return this.attachedPromise
  }

  getStartPromise () {
    return this.startPromise
  }

  onDidChange (callback) {
    if (this.native) {
      const sub = this.native.onDidChange(events => this.onNativeEvents(events, callback))
      this.changeCallbacks.set(callback, sub)

      this.native.start()
    } else {
      // Attach to a new native listener and retry
      this.nativeWatcherRegistry.attach(this).then(() => {
        this.onDidChange(callback)
      })
    }

    return new Disposable(() => {
      const sub = this.changeCallbacks.get(callback)
      this.changeCallbacks.delete(callback)
      sub.dispose()
    })
  }

  onDidError (callback) {
    return this.emitter.on('did-error', callback)
  }

  attachToNative (native) {
    this.subs.dispose()
    this.native = native

    if (native.isRunning()) {
      this.resolveStartPromise()
    } else {
      this.subs.add(native.onDidStart(() => {
        this.resolveStartPromise()
      }))
    }

    // Transfer any native event subscriptions to the new NativeWatcher.
    for (const [callback, formerSub] of this.changeCallbacks) {
      const newSub = native.onDidChange(events => this.onNativeEvents(events, callback))
      this.changeCallbacks.set(callback, newSub)
      formerSub.dispose()
    }

    this.subs.add(native.onDidError(err => {
      this.emitter.emit('did-error', err)
    }))

    this.subs.add(native.onShouldDetach(({replacement, watchedPath}) => {
      if (replacement !== native && this.normalizedPath.startsWith(watchedPath)) {
        this.attachToNative(replacement)
      }
    }))

    this.subs.add(native.onWillStop(() => {
      this.subs.dispose()
      this.native = null
    }))

    this.resolveAttachedPromise()
  }

  onNativeEvents (events, callback) {
    // TODO does event.oldPath resolve symlinks?
    const filtered = events.filter(event => event.oldPath.startsWith(this.normalizedPath))

    if (filtered.length > 0) {
      callback(filtered)
    }
  }

  dispose () {
    for (const sub of this.changeCallbacks.values()) {
      sub.dispose()
    }

    this.emitter.dispose()
    this.subs.dispose()
  }
}

class PathWatcherManager {
  static instance () {
    if (!PathWatcherManager.theManager) {
      PathWatcherManager.theManager = new PathWatcherManager()
    }
    return PathWatcherManager.theManager
  }

  constructor () {
    this.live = new Set()
    this.nativeRegistry = new NativeWatcherRegistry(
      normalizedPath => {
        const nativeWatcher = new NativeWatcher(normalizedPath)

        this.live.add(nativeWatcher)
        const sub = nativeWatcher.onWillStop(() => {
          this.live.delete(nativeWatcher)
          sub.dispose()
        })

        return nativeWatcher
      }
    )
  }

  createWatcher (rootPath, options, eventCallback) {
    console.log(`watching root path = ${rootPath}`)
    const watcher = new PathWatcher(this.nativeRegistry, rootPath, options)
    watcher.onDidChange(eventCallback)
    return watcher
  }

  stopAllWatchers () {
    return Promise.all(
      Array.from(this.live, watcher => watcher.stop())
    )
  }
}

export default function watchPath (rootPath, options, eventCallback) {
  return PathWatcherManager.instance().createWatcher(rootPath, options, eventCallback)
}

// Private: Return a Promise that resolves when all {NativeWatcher} instances associated with a FileSystemManager
// have stopped listening. This is useful for `afterEach()` blocks in unit tests.
export function stopAllWatchers () {
  return PathWatcherManager.instance().stopAllWatchers()
}
