/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// pdfFixtures.js — generates small PDFs for tests: text pages, empty pages, image-only pages,
// a CJK page whose font needs a predefined CMap, and the standard security handler (RC4,
// revision 2) with a user and owner password. Every PDF is built here; no file is checked in.
import { createHash } from "node:crypto";

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts) => createHash("md5").update(Buffer.concat(parts)).digest();
const padPassword = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

function pdfString(text) {
  return "(" + text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}

/**
 * @param {object} spec
 * @param {Array<string|null|{image:true}|{cjk:string}>} spec.pages  text (lines split on "\n"),
 *        null = empty page, { image: true } = a page whose only content is an image (no text layer),
 *        { cjk: "…" } = text in a non-embedded Japanese font encoded with the predefined
 *        UniJIS-UCS2-H CMap, which a reader can only decode with the CMap data files
 * @param {{ userPassword: string, ownerPassword?: string }} [spec.encrypt]
 * @returns {Uint8Array}
 */
export function buildPdf({ pages, encrypt } = {}) {
  const objects = []; // index i → object number i + 1; each entry: { dict, stream? }
  const add = (obj) => { objects.push(obj); return objects.length; };

  const catalog = add(null);
  const pagesObj = add(null);
  const font = add({ dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" });
  const needsCjk = pages.some((p) => p && typeof p === "object" && typeof p.cjk === "string");
  const cjkFont = needsCjk
    ? add({ dict: "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> >>] >>" })
    : 0;
  const needsImage = pages.some((p) => p && typeof p === "object" && p.image);
  const image = needsImage
    ? add({ dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", stream: Buffer.from([0x80]) })
    : 0;

  const pageNums = [];
  for (const page of pages) {
    let content = "";
    if (typeof page === "string") {
      const lines = page.split("\n");
      content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`;
    } else if (page && page.image) {
      content = "q 100 0 0 100 72 600 cm /Im1 Do Q";
    } else if (page && typeof page.cjk === "string") {
      const ucs2 = Buffer.from(page.cjk, "utf16le").swap16().toString("hex");
      content = `BT /F2 12 Tf 72 720 Td <${ucs2}> Tj ET`;
    }
    const contents = add({ dict: "<<", stream: Buffer.from(content, "latin1") });
    const resources = `<< /Font << /F1 ${font} 0 R${cjkFont ? ` /F2 ${cjkFont} 0 R` : ""} >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ""} >>`;
    pageNums.push(add({ dict: `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contents} 0 R >>` }));
  }
  objects[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesObj} 0 R >>` };
  objects[pagesObj - 1] = { dict: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>` };

  const fileId = createHash("md5").update(`tabmail-test-${pages.length}`).digest();
  let fileKey = null;
  let encryptNum = 0;
  if (encrypt) {
    const permissions = -44;
    const ownerKey = md5(padPassword(encrypt.ownerPassword ?? encrypt.userPassword)).subarray(0, 5);
    const O = rc4(ownerKey, padPassword(encrypt.userPassword));
    const P = Buffer.alloc(4);
    P.writeInt32LE(permissions);
    fileKey = md5(padPassword(encrypt.userPassword), O, P, fileId).subarray(0, 5);
    const U = rc4(fileKey, PAD);
    encryptNum = add({ dict: `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${permissions} >>`, plain: true });
  }

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((obj, i) => {
    const num = i + 1;
    let body;
    if (obj.stream) {
      let data = obj.stream;
      if (fileKey && !obj.plain) {
        const objKey = md5(fileKey, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])).subarray(0, 10);
        data = rc4(objKey, data);
      }
      const dict = obj.dict === "<<" ? `<< /Length ${data.length} >>` : `${obj.dict} /Length ${data.length} >>`;
      body = Buffer.concat([Buffer.from(`${num} 0 obj\n${dict}\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    } else {
      body = Buffer.from(`${num} 0 obj\n${obj.dict}\nendobj\n`, "latin1");
    }
    offsets.push(offset);
    chunks.push(body);
    offset += body.length;
  });

  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  const idHex = fileId.toString("hex");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encryptNum ? ` /Encrypt ${encryptNum} 0 R` : ""} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
