/*
 * Lightweight UndoManager (MIT License)
 * Based on https://github.com/ArthurClemens/JavaScript-Undo-Manager (trimmed)
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UndoManager = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  "use strict";

  function UndoManager(limit) {
    this._undoStack = [];
    this._redoStack = [];
    this._limit = typeof limit === 'number' ? limit : 100;
    this._callback = null;
  }

  UndoManager.prototype.setCallback = function (cb) {
    this._callback = typeof cb === 'function' ? cb : null;
  };

  UndoManager.prototype._notify = function () {
    if (this._callback) {
      try { this._callback(this); } catch (e) { console.error('UndoManager callback error', e); }
    }
  };

  UndoManager.prototype._logStack = function(action) {
    try {
      console.groupCollapsed(`[UndoManager] ${action} | undoStack=${this._undoStack.length} redoStack=${this._redoStack.length}`);
      const brief = this._undoStack.map((c,i)=>c._marker||('cmd'+i));
      console.log('Undo stack (top last):', brief);
      console.groupEnd();
    } catch(_) {}
  };

  UndoManager.prototype.add = function (cmd) {
    if (!cmd || typeof cmd.undo !== 'function' || typeof cmd.redo !== 'function') {
      throw new Error('UndoManager.add expects an object with undo() and redo() methods');
    }
    this._undoStack.push(cmd);
    if (this._undoStack.length > this._limit) {
      this._undoStack.shift();
    }
    this._redoStack.length = 0; // clear redo stack on new action
    this._notify();
    this._logStack('add');
  };

  UndoManager.prototype.undo = function () {
    if (!this.canUndo()) { return; }
    var cmd = this._undoStack.pop();
    try { cmd.undo(); } catch (e) { console.error('Undo failed', e); }
    this._redoStack.push(cmd);
    this._notify();
    this._logStack('undo');
  };

  UndoManager.prototype.redo = function () {
    if (!this.canRedo()) { return; }
    var cmd = this._redoStack.pop();
    try { cmd.redo(); } catch (e) { console.error('Redo failed', e); }
    this._undoStack.push(cmd);
    this._notify();
    this._logStack('redo');
  };

  UndoManager.prototype.clear = function () {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._notify();
  };

  UndoManager.prototype.canUndo = function () { return this._undoStack.length > 0; };
  UndoManager.prototype.canRedo = function () { return this._redoStack.length > 0; };
  UndoManager.prototype.hasUndo = UndoManager.prototype.canUndo;
  UndoManager.prototype.hasRedo = UndoManager.prototype.canRedo;

  return UndoManager;
})); 