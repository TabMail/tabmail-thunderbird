/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  folderMembershipIdCandidatesForKey,
  folderMembershipScope,
  makeFolderMembershipId,
} from "../fts/folderMembershipIdentity.js";

describe("durable app-owned folder membership identity", () => {
  it("is a versioned canonical escaped tuple with no Unicode normalization", () => {
    expect(makeFolderMembershipId("acct:work", "/F:%/Caf\u00e9/\ud83d\udce8"))
      .toBe('tm-folder:v1:["acct:work","/F:%/Caf\u00e9/\ud83d\udce8"]');
    expect(makeFolderMembershipId("acct:work", "/F:%/Cafe\u0301/\ud83d\udce8"))
      .toBe('tm-folder:v1:["acct:work","/F:%/Cafe\u0301/\ud83d\udce8"]');
    expect(makeFolderMembershipId("acct:work", "/F:%/Caf\u00e9/\ud83d\udce8"))
      .not.toBe(makeFolderMembershipId("acct:work", "/F:%/Cafe\u0301/\ud83d\udce8"));
  });

  it("is injective across delimiter-looking account/path tuples", () => {
    expect(makeFolderMembershipId("a:b", "/c"))
      .not.toBe(makeFolderMembershipId("a", "b:/c"));
    expect(makeFolderMembershipId("a", "/b:%"))
      .not.toBe(makeFolderMembershipId("a:/b", "%"));
  });
});

describe("folder-scope attribution of native keys", () => {
  it("names the owning folder of a plain key", () => {
    expect(folderMembershipIdCandidatesForKey("account1:/INBOX:abc@example.com"))
      .toEqual([makeFolderMembershipId("account1", "/INBOX")]);
  });

  it("names every split of colon-bearing paths, Message-IDs and account ids", () => {
    const candidates = folderMembershipIdCandidatesForKey("acct:work:/F:Child:id:part@example.com");
    for (const [accountId, folderPath] of [
      ["acct:work", "/F:Child"],
      ["acct:work", "/F"],
      ["acct", "work:/F"],
    ]) {
      expect(candidates).toContain(makeFolderMembershipId(accountId, folderPath));
    }
  });

  it("attributes a child folder's key to its parent's key range too", () => {
    expect(folderMembershipIdCandidatesForKey("account1:/F:Child:abc@example.com"))
      .toEqual(expect.arrayContaining([
        makeFolderMembershipId("account1", "/F"),
        makeFolderMembershipId("account1", "/F:Child"),
      ]));
  });

  it("returns null for a key with no account/path split", () => {
    for (const key of ["", "nocolon", "account1:", ":/INBOX:id", "account1::id", "account1:/INBOX:", null, 42]) {
      expect(folderMembershipIdCandidatesForKey(key)).toBeNull();
    }
  });

  it("scopes a batch to every candidate plus explicit owners, or the wildcard", () => {
    const scope = folderMembershipScope(
      ["account1:/A:x@example.com", "account1:/B:y@example.com"],
      ["explicit-owner", null],
    );
    expect([...scope].sort()).toEqual([
      makeFolderMembershipId("account1", "/A"),
      makeFolderMembershipId("account1", "/B"),
      "explicit-owner",
    ].sort());
    expect(folderMembershipScope(["account1:/A:x@example.com", "bad"])).toBe("*");
  });
});
