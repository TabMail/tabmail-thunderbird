var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Pauses undo operations while executing the provided callback.
   *
   * The helper tries to grab the current nsIEditor via GetCurrentEditor() or
   * gMsgCompose.editor. If neither is available it still runs the callback.
   *
   * This API exists in all recent Thunderbird versions (enableUndo). We simply
   * toggle it off -> run callback -> toggle back on.
   *
   * Nested calls are harmless because enableUndo(true) is idempotent.
   *
   * @param {Function} callback The work to perform while undo is paused.
   * @returns {*} The callback's return value.
   */
  withUndoPaused: function (callback) {
    // Debug: log each invocation with current depth (before increment)
    console.log(
      "[TMDBG Undo] withUndoPaused called. Current depth (pre-increment):",
      TabMail._undoPauseDepth || 0
    );
    try {
      let globalEditor = null;
      try {
        globalEditor =
          typeof GetCurrentEditor === "function" ? GetCurrentEditor() : null;
      } catch {}
      let topEditor = null;
      try {
        if (window.top && typeof window.top.GetCurrentEditor === "function") {
          topEditor = window.top.GetCurrentEditor();
        }
      } catch {}

      if (TabMail._undoPauseDepth === undefined) {
        // only log once per page load the capabilities
        console.log(
          "[TMDBG Undo] Capability check: typeof GetCurrentEditor",
          typeof GetCurrentEditor,
          "typeof window.top.GetCurrentEditor",
          window.top && typeof window.top.GetCurrentEditor
        );
      }

      const nsEditor =
        globalEditor ||
        topEditor ||
        (window.gMsgCompose && window.gMsgCompose.editor);

      if (!nsEditor) {
        if (TabMail.state && TabMail.state.editorRef) {
          const protoKeys = Object.getOwnPropertyNames(
            Object.getPrototypeOf(TabMail.state.editorRef) || {}
          );
          console.log(
            "[TMDBG Undo] editorRef available. Prototype keys (sample):",
            protoKeys.slice(0, 10)
          );
          console.log(
            "[TMDBG Undo] editorRef.enableUndo ?",
            typeof TabMail.state.editorRef.enableUndo
          );
        }
        console.log(
          "[TMDBG Undo] nsEditor not found. Proceeding without toggling undo."
        );
      }

      // Track nested invocations so we only toggle once at the outermost call.
      TabMail._undoPauseDepth = (TabMail._undoPauseDepth || 0) + 1;
      console.log(
        "[TMDBG Undo] Depth after increment:",
        TabMail._undoPauseDepth
      );

      let didToggleUndo = false;
      let didSuppressInput = false;

      if (TabMail._undoPauseDepth === 1 && nsEditor) {
        if (typeof nsEditor.enableUndo === "function") {
          console.log(
            "[TMDBG Undo] Disabling undo (enableUndo(false)) at depth",
            TabMail._undoPauseDepth
          );
          nsEditor.enableUndo(false);
          didToggleUndo = true;
        }
        if (typeof nsEditor.suppressDispatchingInputEvent === "function") {
          nsEditor.suppressDispatchingInputEvent(true);
          didSuppressInput = true;
        }
      }

      try {
        return callback();
      } finally {
        if (TabMail._undoPauseDepth === 1 && nsEditor) {
          if (didSuppressInput) {
            try {
              nsEditor.suppressDispatchingInputEvent(false);
            } catch {}
          }
          if (didToggleUndo) {
            try {
              console.log(
                "[TMDBG Undo] Re-enabling undo (enableUndo(true)) at depth",
                TabMail._undoPauseDepth
              );
              nsEditor.enableUndo(true);
            } catch {}
          }
        }
        TabMail._undoPauseDepth -= 1;
        console.log(
          "[TMDBG Undo] Exiting withUndoPaused. Depth after decrement:",
          TabMail._undoPauseDepth
        );
      }
    } catch (err) {
      console.error("[TabMail] withUndoPaused error:", err);
      return callback();
    }
  },

  /**
   * Registers a before/after snapshot with the global undo manager.
   * Centralised helper to avoid repetition across event handlers.
   *
   * @param {string} beforeText - Plaintext before the edit.
   * @param {number} beforeCursor - Cursor offset before the edit.
   * @param {string} afterText - Plaintext after the edit.
   * @param {number} afterCursor - Cursor offset after the edit.
   * @param {string} [marker='typing'] - Optional marker for the snapshot.
   */
  pushUndoSnapshot: function (
    beforeText,
    beforeCursor,
    afterText,
    afterCursor,
    marker = "typing"
  ) {
    if (!TabMail.undoManager || beforeText === afterText) {
      return; // Nothing to do, or undo manager not ready.
    }

    const editor = TabMail.state && TabMail.state.editorRef;
    if (!editor) {
      console.warn(
        "[TabMail Undo] Editor reference missing, cannot push snapshot."
      );
      return;
    }

    try {
      TabMail.undoManager.add({
        _marker: marker,
        undo: () => {
          TabMail.withUndoPaused(() => {
            TabMail.setEditorPlainText(editor, beforeText);
          });
          TabMail.log.debug('undo', "Setting cursor by offset.", beforeCursor);
          TabMail.setCursorByOffset(editor, beforeCursor);
        },
        redo: () => {
          TabMail.withUndoPaused(() => {
            TabMail.setEditorPlainText(editor, afterText);
          });
          TabMail.log.debug('undo', "Setting cursor by offset.", afterCursor);
          TabMail.setCursorByOffset(editor, afterCursor);
        },
      });
    } catch (err) {
      console.error("[TabMail Undo] Failed to register snapshot:", err);
    }
  },
}); 