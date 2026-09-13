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

Verified on Thunderbird Beta 156.0 on macOS: HTML probe 6/6 and plaintext probe passed; light and actual dark theme inspected; mouse acceptance and physical Tab accepted a complete formatted suggestion; native Undo/Redo restored/reapplied it. The original theme was restored afterward. The revised accent treatment was also inspected in both native themes: the source sentence has a blue underline with no fill, and inserted preview wording has a blue tint. The preview remained outside the serialized message body. A wrapped sentence showed only its intersecting lines and same-line muted context. The long-preview scroll position and immediate caret-move/Tab ordering probes passed after an extension reload. Invoking the registered send-cleanup callback, waiting for its guard to expire, and supplying a successful synthetic correction after new input restored a visible proposal without changing the authored draft; no send was attempted. The same recovery check passed after opening and canceling inline edit immediately before cleanup, with its visibility-restoration timer still pending.

Limits: native Undo selects the replaced editable region, and Redo restores Thunderbird's command selection rather than replaying the post-accept caret adjustment. At a window narrower than Thunderbird's own compose document minimum, native chrome can clip the document (including its preview). These probes do not claim testing on every supported Thunderbird version.
