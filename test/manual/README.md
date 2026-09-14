# Native compose smoke probes

These probes run inside actual Thunderbird compose documents. Use disposable drafts only. They require the exact initial body `COMPOSE PREVIEW SMOKE`, replace that synthetic body, and never send mail.

Reload the working add-on from `about:debugging` after changing source or probe files (Thunderbird may cache scripts), inspect its background console, then create an HTML draft. The compose modules and styles must load through the add-on’s actual registration:

```js
var smoke = await messenger.compose.beginNew({
  isPlainText: false,
  subject: 'Disposable native compose smoke',
  body: 'COMPOSE PREVIEW SMOKE'
});
```

Once the compose window has opened, return to the console and run:

```js
JSON.stringify(await messenger.scripting.executeScript({
  target: { tabId: smoke.id },
  files: ['test/manual/composePreviewSmoke.js']
}));
```

The HTML probe must return `passed: 6, total: 6`. For plaintext, create a separate draft with `isPlainText: true` and `plainTextBody: 'COMPOSE PREVIEW SMOKE'`, then run `test/manual/composePlainSmoke.js`. It must return `pass: true`. The plaintext probe exercises Disable and Enable, leaving suggestions enabled. Close both synthetic drafts and discard changes afterward.

Also inspect light/dark presentation and a wrapped mid-paragraph sentence, click Accept, press physical Tab, and use the native Undo/Redo shortcuts. Synthetic DOM event dispatch verifies the registered handler, but cannot establish physical key routing by itself.

Verified on Thunderbird Beta 156.0 on macOS: HTML probe 6/6 and plaintext probe passed; light and actual dark theme inspected; mouse acceptance and physical Tab accepted a complete formatted suggestion; native Undo/Redo restored/reapplied it. The original theme was restored afterward. The revised accent treatment was also inspected in both native themes: the source sentence has a blue underline with no fill, and inserted preview wording has a blue tint. After replacing CSS Highlight decorations with compatible range-based overlay lines, both probes passed again; native wrapped rich-text checks confirmed visible underlines, no fill, unchanged authored HTML, and underline fragments outside the body in both themes. That check established BODY separation only; it did not prove native serialization exclusion. Use the native encoder/save/reopen procedure below for that invariant. A wrapped sentence showed only its intersecting lines and same-line muted context. The long-preview scroll position and immediate caret-move/Tab ordering probes passed after an extension reload. Invoking the registered send-cleanup callback, waiting for its guard to expire, and supplying a successful synthetic correction after new input restored a visible proposal without changing the authored draft; no send was attempted. The same recovery check passed after opening and canceling inline edit immediately before cleanup, with its visibility-restoration timer still pending.

Limits: native Undo selects the replaced editable region, and Redo restores Thunderbird's command selection rather than replaying the post-accept caret adjustment. At a window narrower than Thunderbird's own compose document minimum, native chrome can clip the document (including its preview). These probes do not claim testing on every supported Thunderbird version.

### Cmd-K caret focus handoff

On macOS Beta 156.0, applying Cmd-K could leave the native body caret invisible even though typing continued to insert text. Leaving the application and returning, or focusing a compose header and then the body, restored it. A valid DOM selection, a non-transparent computed caret color, and `document.activeElement === body` were **not sufficient proof** that Gecko was painting the caret. Disabling the apply animation did not fix this reproduction.

The verified cleanup sequence in `inlineEditor.js` uses the existing instruction iframe, before removing it: keep its container transparent, make its input focusable again, focus the instruction input, focus the compose content window, focus the body, then remove the popup and restore the body's saved caret color/designMode through normal cleanup. The body caret remains transparent during the handoff to avoid dual carets. The native HTML transaction and its selection placement remain unchanged. Do not replace this with only a body `focus()` after removing the frame, create a second focus iframe, switch applications, or add a delayed focus-stealing timer. The apply handoff is guarded by document focus and runs synchronously while the existing execution guard suppresses popup focus-out cleanup.

Regression procedure: in a disposable HTML draft containing `Please confirm Friday.`, put the caret in the body, open Cmd-K, request a different weekday, and apply with physical Enter. Without clicking the body or switching windows, type a character and inspect the visible caret. Repeat using the clickable Edit draft action. Check that only the instruction caret is shown while Cmd-K is open, Escape returns to the body, and native Undo first removes the typed character and then restores the pre-edit draft. Repeat applications in the same window. DOM tests assert the focus-before-removal sequence and single existing iframe, but do not substitute for this native painter check.

When testing changed source in an already-open disposable draft, verify the loaded function contains the new implementation. Thunderbird can cache `scripting.executeScript` file sources; reloading a cached file is not evidence that the candidate was tested. Use a normal add-on reload for fresh full-session validation, or a cache-busted script URL for a narrowly scoped disposable-draft check without interrupting other open drafts.

Verified with the loaded final implementation on macOS Beta 156.0: physical Enter and clickable Edit draft both left a visible body caret after subsequent typing; only the instruction caret was visible while Cmd-K was open; Escape restored the body caret; two native Undo commands removed the typed character and then restored the pre-edit draft. This was a disposable HTML-draft check, not a claim that every Gecko version was tested.

Surface refinement checked in the existing Beta 156.0 session: HTML probe 6/6; light/dark screenshots inspected; measured 8px left/right insets, 0.92 background alpha, and approximately 16.2px preview text for an 18px draft. Authored content remained unchanged. The disposable draft was discarded and the system theme restored.


### Native serialization check

Use a fresh disposable draft after reloading the extension. Give authored text and proposed text distinct markers. Keep an unaccepted preview visible, then read both `browser.compose.getComposeDetails(tabId).plainTextBody` and the decoded text of its HTML `body` (parse with DOMParser; do not search raw HTML, because highlighted spans can split words). Both must contain the authored marker and exclude the proposal marker and action labels.

Save through Thunderbird's native Save command while the preview is still visible. Close the draft, locate that exact synthetic subject, and inspect `browser.messages.getFull(messageId)`: recursively decode every text/html MIME part with DOMParser and inspect every text/plain part. Reopen the saved message with Edit As New Message and verify its compose body contains only the authored text. Do not send it. Discard the reopened copy and move the saved disposable draft to Trash. An older autosaved copy from a pre-fix extension is not evidence for the current candidate; use a unique subject for each candidate.

Post-isolation verification on Beta 156.0: a fresh draft with an unaccepted shadow preview returned only authored text in both plainTextBody and decoded HTML from getComposeDetails. Native Save, decoded MIME inspection of Drafts and its mirrored copy, and reopening with the native Edit action all retained only authored text. The disposable draft was moved to Trash. The pre-fix direct-child preview was observed in plain-text serialization and in a saved draft, establishing a native red/green comparison; raw HTML substring searches were insufficient because highlight spans split the marker.

After an extension reload with the final registered scripts, the native six-case HTML probe passed with synchronously injected shadow styles (format preservation, undo/redo, media refusal, full initial proposal, continuation, scroll retention, and stale-caret protection). Linked extension stylesheets produced empty rule lists in the compose shadow tree; the preview CSS is therefore supplied by the compose script itself.
