/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  folderMembershipKeyAccountEnd,
  folderMembershipKeyPrefix,
  makeFolderMembershipId,
  parseFolderMembershipId,
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

describe("matching native keys to a folder", () => {
  it("parses back exactly the tuple an identity was made from", () => {
    for (const [accountId, folderPath] of [["account1", "/INBOX"], ["acct:work", "/F:%/Cafe\u0301/\ud83d\udce8"]]) {
      expect(parseFolderMembershipId(makeFolderMembershipId(accountId, folderPath)))
        .toEqual({ accountId, folderPath });
    }
  });

  it("parses nothing it did not make", () => {
    for (const value of [
      null, 42, "", "folder-cold", "tm-folder:v1:", "tm-folder:v1:not json",
      'tm-folder:v1:["account1"]', 'tm-folder:v1:["account1",""]', 'tm-folder:v1:["account1",7]',
      'tm-folder:v2:["account1","/INBOX"]',
    ]) {
      expect(parseFolderMembershipId(value)).toBeNull();
    }
  });

  it("ends the account at the first colon, with or without colons later in the key", () => {
    expect(folderMembershipKeyAccountEnd("account1:/INBOX:abc@example.com")).toBe(8);
    expect(folderMembershipKeyAccountEnd("account1:/F:Child:id:part@example.com")).toBe(8);
  });

  it("finds no split in a key without an account, a path and a remainder", () => {
    for (const key of ["", "nocolon", "account1:", ":/INBOX:id", "account1::id", "account1:/INBOX:", null, 42]) {
      expect(folderMembershipKeyAccountEnd(key)).toBe(-1);
    }
  });

  it("prefixes every key in a folder's range, its child folders' keys included", () => {
    const prefix = folderMembershipKeyPrefix("account1", "/F");
    expect("account1:/F:abc@example.com".startsWith(prefix)).toBe(true);
    expect("account1:/F:Child:abc@example.com".startsWith(prefix)).toBe(true);
    expect("account1:/FF:abc@example.com".startsWith(prefix)).toBe(false);
  });
});
