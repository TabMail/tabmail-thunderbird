/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const { ExtensionCommon: TMRecipientExtensionCommon } = ChromeUtils.importESModule(
  'resource://gre/modules/ExtensionCommon.sys.mjs'
);
const { MailServices: TMRecipientMailServices } = ChromeUtils.importESModule(
  'resource:///modules/MailServices.sys.mjs'
);
const { parseEncodedAddrHeader: tmRecipientHeaderList } = ChromeUtils.importESModule(
  'resource:///modules/ExtensionMessages.sys.mjs'
);

var tmComposeRecipients = class extends TMRecipientExtensionCommon.ExtensionAPI {
  getAPI(context) {
    this.operations = new WeakMap();
    const composeWindow = tabId => {
      const tab = context.extension.tabManager.get(tabId);
      if (tab.type !== 'messageCompose' || tab.nativeTab.closed) throw new Error('Invalid compose tab');
      return tab.nativeTab;
    };
    return { tmComposeRecipients: {
      begin: async tabId => {
        const win = composeWindow(tabId);
        const id = Services.uuid.generateUUID().toString();
        this.operations.set(win, id);
        return id;
      },
      commit: async (tabId, id, baseline, deltas) => {
        const win = composeWindow(tabId);
        if (this.operations.get(win) !== id) return false;
        this.operations.delete(win);
        // Public compose.setComposeDetails awaits recipient parsing between read
        // and write. Keep validation and SetComposeDetails in ONE native turn:
        // a later user action must never be overwritten by an older proposal.
        // Only mailboxes are written; no async address-book resolution.
        // GetComposeDetails serializes committed pills only. Preserve unfinished
        // manual input (including an existing pill being edited) before native
        // SetComposeDetails rebuilds the address rows and discards that input.
        for (const field of ['to', 'cc', 'bcc']) {
          const row = win.document.querySelector(`.address-row[data-recipienttype="addr_${field}"]`);
          if (row?.querySelector('.address-row-input')?.value ||
              Array.from(row?.querySelectorAll('mail-address-pill') || []).some(pill => pill.isEditing)) return false;
        }
        const current = win.GetComposeDetails();
        for (const field of ['to', 'cc', 'bcc']) {
          if (JSON.stringify(tmRecipientHeaderList(current[field], false)) !== JSON.stringify(baseline[field])) return false;
        }
        // Each changed field is Thunderbird's own parse of the window's field (the parse
        // behind the compose API's recipient strings), minus the removed addresses, plus
        // the added mailboxes, each written as header text with Thunderbird's own
        // makeMimeAddress, the way Thunderbird writes every pill at Send. So for a name
        // Thunderbird reads back as one name, the pills this write makes are what Send
        // reads; a name with an unbalanced quote mark is read as Thunderbird reads such a
        // header itself. A pill with no address (typed text that is not an address) is
        // kept like any other recipient.
        const nativePatch = {};
        for (const field of ['to', 'cc', 'bcc']) {
          // Optional schema properties arrive as null at the experiment boundary.
          const delta = deltas[field];
          if (delta == null) continue;
          const removes = delta.removes || [];
          const removed = new Set(removes.filter(email => email !== '*').map(email => email.toLowerCase()));
          const mailboxes = removes.includes('*') ? [] :
            TMRecipientMailServices.headerParser.parseEncodedHeaderW(current[field] || '')
              .filter(mailbox => !removed.has(mailbox.email.toLowerCase()));
          const seen = new Set(mailboxes.map(mailbox => mailbox.email.toLowerCase()));
          for (const add of delta.adds || []) {
            const email = String(add.email || '').trim();
            if (!email || email === '*' || seen.has(email.toLowerCase())) continue;
            mailboxes.push({ name: String(add.name || '').trim(), email });
            seen.add(email.toLowerCase());
          }
          nativePatch[field] = mailboxes
            .map(mailbox => TMRecipientMailServices.headerParser.makeMimeAddress(mailbox.name, mailbox.email))
            .join(',');
        }
        if (Object.keys(nativePatch).length) {
          const active = win.document.activeElement;
          win.SetComposeDetails(nativePatch);
          active?.focus();
        }
        return true;
      },
    }};
  }
  onShutdown() { this.operations = new WeakMap(); }
};
