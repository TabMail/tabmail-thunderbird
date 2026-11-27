# The assistant signs an email as the identity it is sent from (#472)

Recorded 2026-11-27.

- **Defect.** The email bodies the assistant writes through a model request that carries `user_name`
  (a compose window's Cmd-K edit, the chat's new email, reply and forward, and the prepared reply)
  were signed with `getUserName`: the first identity of the first account in `accounts.list()`,
  whatever identity the email went from. A user writing from a second account got a body signed with
  the first account's name. Autocomplete was not affected: it already sends the window's From as
  `sender_info`. `getUserName` stays for what is about the user rather than a sender (chat greetings,
  check-ins, summaries, actions).
- **Which identity sends.**
  - A compose window: `compose.getComposeDetails(tabId).identityId`.
  - A compose window opened through the WebExtension API with no `identityId`
    (`compose.beginNew/beginReply/beginForward`): Thunderbird's `ComposeStartup`
    (`MsgComposeCommands.js`) takes `MailServices.accounts.defaultAccount.defaultIdentity` when the
    window has no identity and no From to match. In the API that is `accounts.getDefault()` and its
    `identities[0]`, the default identity (`accountsRead`).
  - **The default account is not necessarily the first in `accounts.list()`.**
    `nsMsgAccountManager::SetDefaultAccount` changes only the default pref and does not reorder the
    accounts (checked in comm-central source, 2026-11-27). So "first account, first identity" can
    differ from what a new window sends from.
  - The chat's `send_email` opens a reply or forward with `getIdentityForMessage(replyToId |
    forwardOfId)` (the message's account's identity whose address is the account's, else its first),
    and a new email with no identity.
- **Fix.** `getSendingIdentity(identityId)` in `chat/modules/helpers.js` is the identity an email
  is sent from: the one the id names, or with none the default account's default identity, which is
  Thunderbird's own rule above (a `MailAccount` lists its default identity first, so that is
  `accounts.getDefault()`'s `identities[0]`). `getSenderName(identityId)` names it (full name, else
  the address before the @; when nothing resolves or a lookup fails, the placeholder "there" that
  `getUserName` also sends, never another identity's name. The request carries "there" as the
  user's name, so it does not guarantee an unsigned body). `runComposeEdit` and `buildComposeEditChat` take `identityId`:
  - the compose window's Cmd-K edit passes `details.identityId`;
  - the chat's `email_reply` and `email_forward` pass `getIdentityForMessage` of the same id
    `send_email` opens the window with. Each looks it up on its own, so a change of identity in the
    seconds between writing and sending (or the window's From switched during a Cmd-K edit) can leave
    the body naming the earlier identity: a rare timing window, thunderbird#473 (P4);
  - the chat's `email_compose` passes none (`send_email` calls `beginNew` with none);
  - a prepared reply (`replyGenerator.cacheReply`) passes its message's `getIdentityForMessage`.
    It is written before any window exists; a reply window Thunderbird later opens from its own Reply
    button picks the identity from the message's recipients and folder, which can differ when the
    message was sent to another identity than its account's default, or when it sits in a folder
    whose account has no identity of its own (Local Folders, a POP account's global inbox):
    Thunderbird answers that from the identity the message was addressed to, while the body is
    signed as the default account's identity. The cache is keyed by the
    message alone, so that window is offered the body signed as the account's identity; a reply
    window that finds no cached reply has one written then, also as the account's identity
    (thunderbird#474, P3: store the signing identity's address with each cached reply).
- **Same cause, same fix, in the chat's send step (`chat/fsm/emailCompose.js`).** It read
  `accounts.list()[0].identities[0]` twice more where the sending identity is meant:
  - the preview's From line for a new email now shows `getSendingIdentity()`, the identity the
    window opens with;
  - the HTML or plain-text choice: every desktop `beginNew`, `beginReply` and `beginForward`
    (`runStateSendEmail`) forced `isPlainText` from the first identity's `composeHtml`. It now gives
    none, and
    Thunderbird composes as the identity the window sends from prefers: `ext-compose.js`
    `openComposeWindow` leaves the format `Default` when neither `isPlainText` nor a body is given,
    and `nsMsgCompose::Initialize` passes the window's identity to
    `nsMsgComposeService::DetermineComposeHTML`, which reads its `composeHtml` (comm-central source,
    checked 2026-11-27). This also holds for a reply Thunderbird picks the identity for itself. The
    draft's body reaches the window either way: a reply's through the reply cache, a new email's or
    forward's through `activePrecompose:<tab>`, both inserted by the compose content script.
  - the headless send step (`runStateSendEmailHeadless`) keeps the first identity's format,
    unchanged: its body writer `setComposeBody` (chatlink/modules/compose.js) sets only
    `plainTextBody`, which Thunderbird 145's `setComposeDetails` drops for an HTML window, so
    letting the identity choose HTML there would send without the body. The path is dormant
    (`headlessComposeEnabled` is false, and ChatLink is retired: its service no longer runs), so
    it is not maintained.
- **Not changed.** Which identity any window opens with.
- **Tests.** `test/assistantSignsAsSender.test.js` (the first account is never the sender, so a name
  taken from it fails every case; for the chat the real send step then opens the window, which must
  send from the identity the body is signed as; an unresolved or failed lookup, or an identity with
  neither name nor address, sends "there"; a retried edit keeps the name), `test/composeInlineRecovery.test.js` (a new, reply and forward
  window's edit is asked for signed as the identity that window sends from), and `test/chatComposeSendingIdentity.test.js` (the
  preview's From, a nameless identity's by its address alone, none when it cannot be read, and each desktop window's format under
  a fake of Thunderbird's own format rule, with the first account always preferring the other
  format, the draft's body staged for it, and a reply or forward whose message's identity does not
  resolve opened with none rather than an empty one).
