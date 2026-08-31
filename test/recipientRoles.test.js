/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));

const parseMailboxString = vi.fn(async (raw, preserveGroups) => {
  const value = String(raw).trim();
  if (value === "throws@example.com") throw new Error("parser failure");
  if (value === "multiple@example.com") {
    return [{ email: "multiple@example.com" }, { email: "second@example.com" }];
  }
  if (value === "Group: member@example.com;") {
    return preserveGroups
      ? [{ name: "Group", group: [{ email: "member@example.com" }] }]
      : [{ email: "member@example.com" }];
  }
  const match = value.match(/<([^<>]+)>$/);
  const email = (match ? match[1] : value).trim();
  if (
    !email ||
    email.startsWith(".") ||
    email.endsWith(".") ||
    email.includes("..") ||
    !email.includes("@") ||
    (/\s/.test(email) && !/^"[^"]+"@/.test(email))
  ) {
    return [];
  }
  return [{ email }];
});
globalThis.messenger = { messengerUtilities: { parseMailboxString } };

const { removeToDuplicatesFromCc } = await import(
  "../agent/modules/recipientRoles.js"
);
const { buildInlineRecipientPatch } = await import(
  "../compose/modules/recipientDeltas.js"
);

describe("removeToDuplicatesFromCc", () => {
  it("matches one parsed mailbox case-insensitively and preserves other values", async () => {
    const cc = [
      "Different name <person@example.com>",
      "other@example.com",
      "not-an-address",
      "person+tag@example.com",
    ];

    expect(
      await removeToDuplicatesFromCc(["Primary <Person@Example.com>"], cc)
    ).toEqual([
      "other@example.com",
      "not-an-address",
      "person+tag@example.com",
    ]);
  });

  it("does not guess that malformed object entries are the same recipient", async () => {
    const malformedCc = { name: "Cc", email: "not-an-address" };
    expect(
      await removeToDuplicatesFromCc(
        [{ name: "To", email: "not-an-address" }],
        [malformedCc]
      )
    ).toEqual([malformedCc]);
  });

  it("preserves address-shaped substrings and malformed bracket forms", async () => {
    const malformed = [
      "broken person@example.com trailing",
      "Display <person@example.com> trailing",
      "Display <person@example.com",
    ];

    expect(await removeToDuplicatesFromCc(["person@example.com"], malformed)).toEqual(
      malformed
    );
  });

  it("preserves malformed dot-atom addresses", async () => {
    const malformed = [
      ".person@example.com",
      "person..alias@example.com",
      "person@example..com",
    ];

    expect(await removeToDuplicatesFromCc(malformed, malformed)).toEqual(malformed);
  });

  it("accepts quoted and domain-literal RFC mailboxes", async () => {
    const quoted = '"local part"@example.com';
    const domainLiteral = "person@[192.0.2.1]";

    expect(
      await removeToDuplicatesFromCc(
        [quoted, domainLiteral],
        [`Quoted <${quoted}>`, `Literal <${domainLiteral}>`, "other@example.com"]
      )
    ).toEqual(["other@example.com"]);
  });

  it("preserves parser failures, groups, and multi-mailbox strings", async () => {
    const unambiguous = [
      "throws@example.com",
      "multiple@example.com",
      "Group: member@example.com;",
    ];
    expect(await removeToDuplicatesFromCc(unambiguous, unambiguous)).toEqual(
      unambiguous
    );
    expect(parseMailboxString).toHaveBeenCalledWith(
      "Group: member@example.com;",
      true
    );
  });
});

describe("buildInlineRecipientPatch", () => {
  it("drops a Cc addition that duplicates an unchanged To recipient", async () => {
    const patch = await buildInlineRecipientPatch(
      {
        to: ["Primary <person@example.com>"],
        cc: ["other@example.com"],
        bcc: [],
      },
      {
        to: undefined,
        cc: {
          adds: [{ name: "Duplicate", email: "PERSON@example.com" }],
          removes: [],
        },
        bcc: undefined,
      },
      parseMailboxString
    );

    expect(patch).toEqual({ cc: ["other@example.com"] });
  });

  it("patches Cc when a To addition promotes one of its recipients", async () => {
    const patch = await buildInlineRecipientPatch(
      {
        to: ["first@example.com"],
        cc: ["Promoted <person@example.com>", "other@example.com"],
        bcc: [],
      },
      {
        to: {
          adds: [{ name: "Primary", email: "PERSON@example.com" }],
          removes: [],
        },
        cc: undefined,
        bcc: undefined,
      },
      parseMailboxString
    );

    expect(patch).toEqual({
      to: ["first@example.com", "Primary <PERSON@example.com>"],
      cc: ["other@example.com"],
    });
  });

  it("keeps prior remove, clear, and within-field dedupe behavior without reformatting survivors", async () => {
    const patch = await buildInlineRecipientPatch(
      {
        to: [],
        cc: ['"Doe, Jane" <jane@example.com>', "old@example.com"],
        bcc: ["old-private@example.com"],
      },
      {
        to: undefined,
        cc: {
          adds: [
            { name: "Duplicate", email: "JANE@example.com" },
            { name: "New", email: "new@example.com" },
          ],
          removes: ["old@example.com"],
        },
        bcc: {
          adds: [{ name: "Private", email: "new-private@example.com" }],
          removes: ["*"],
        },
      },
      parseMailboxString
    );

    expect(patch).toEqual({
      cc: ['"Doe, Jane" <jane@example.com>', "New <new@example.com>"],
      bcc: ["Private <new-private@example.com>"],
    });
  });

  it("does not emit recipient changes for a body-only edit", async () => {
    expect(
      await buildInlineRecipientPatch(
        { to: ["person@example.com"], cc: [], bcc: [] },
        { to: undefined, cc: undefined, bcc: undefined },
        parseMailboxString
      )
    ).toEqual({});
  });

  it("does not apply To precedence to Bcc", async () => {
    const patch = await buildInlineRecipientPatch(
      { to: ["person@example.com"], cc: [], bcc: [] },
      {
        to: undefined,
        cc: undefined,
        bcc: {
          adds: [{ name: "Private", email: "person@example.com" }],
          removes: [],
        },
      },
      parseMailboxString
    );

    expect(patch).toEqual({ bcc: ["Private <person@example.com>"] });
  });

  it("keeps malformed Cc entries during a To-only inline edit", async () => {
    const malformed = "Display <person@example.com> trailing";
    const patch = await buildInlineRecipientPatch(
      { to: ["person@example.com"], cc: [malformed], bcc: [] },
      {
        to: { adds: [{ name: "", email: "other@example.com" }], removes: [] },
        cc: undefined,
        bcc: undefined,
      },
      parseMailboxString
    );

    expect(patch).toEqual({
      to: ["person@example.com", "other@example.com"],
    });
  });

  it("preserves quoted-comma survivor bytes while formatting only additions", async () => {
    const quoted = '"Doe, Jane" <jane@example.com>';
    expect(
      await buildInlineRecipientPatch(
        { to: [], cc: [quoted], bcc: [] },
        {
          to: undefined,
          cc: { adds: [{ name: "New", email: "new@example.com" }], removes: [] },
          bcc: undefined,
        },
        parseMailboxString
      )
    ).toEqual({ cc: [quoted, "New <new@example.com>"] });
  });

  it("keeps unparsable raw values when an AI delta changes the same field", async () => {
    expect(
      await buildInlineRecipientPatch(
        { to: ["throws@example.com", "multiple@example.com"], cc: [], bcc: [] },
        {
          to: { adds: [{ name: "New", email: "new@example.com" }], removes: [] },
          cc: undefined,
          bcc: undefined,
        },
        parseMailboxString
      )
    ).toEqual({ to: ["throws@example.com", "multiple@example.com", "New <new@example.com>"] });
  });

  it("does not flatten a one-member group while applying an inline AI delta", async () => {
    const group = "Group: member@example.com;";
    expect(
      await buildInlineRecipientPatch(
        { to: [group], cc: ["member@example.com"], bcc: [] },
        {
          to: { adds: [{ name: "New", email: "new@example.com" }], removes: [] },
          cc: undefined,
          bcc: undefined,
        },
        parseMailboxString
      )
    ).toEqual({ to: [group, "New <new@example.com>"] });
    expect(parseMailboxString).toHaveBeenCalledWith(group, true);
  });
});
