/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { makeFolderMembershipId } from "../fts/folderMembershipIdentity.js";

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
