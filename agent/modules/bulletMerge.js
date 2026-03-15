// bulletMerge.js – 3-way bullet merge for P2P sync text fields
//
// Merges independent bullet additions/removals from two peers using a shared base.
// Algorithm: set-based merge preserving local ordering.
//   - Remote removals are applied to local
//   - Remote additions are appended to local
//   - Duplicate bullets are deduplicated
//
// Used by p2pSync.js for composition, action, and kb fields.

import { log } from "./utils.js";

const PFX = "[BulletMerge] ";

// Section headers matching both iOS PromptParser and TB parseMarkdown
const COMPOSITION_SECTIONS = [
  "General writing style",
  "Language",
  "Useful links to personal website and other resources",
];

const ACTION_SECTIONS = [
  "Emails to be marked as `delete`",
  "Emails to be marked as `archive`",
  "Emails to be marked as `reply`",
  "Emails to be marked as `none`",
];

/**
 * Extract bullets from text. Each line starting with "- " is a bullet.
 * @param {string} text
 * @returns {string[]} Array of bullet contents (without "- " prefix)
 */
function extractBullets(text) {
  if (!text) return [];
  return text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

/**
 * Extract the content of a section from markdown.
 * Matches iOS PromptParser.extractSection().
 * @param {string} markdown
 * @param {string} header - Section header text (without "DO NOT EDIT" suffix)
 * @returns {string} Section content between this header and the next
 */
function extractSection(markdown, header) {
  const lines = markdown.split("\n");
  let capturing = false;
  const content = [];

  for (const line of lines) {
    if (line.includes(header) && line.includes("DO NOT EDIT/DELETE THIS SECTION HEADER")) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if ((line.startsWith("# ") && line.includes("DO NOT EDIT/DELETE THIS SECTION HEADER"))
          || line.includes("====END USER INSTRUCTIONS====")) {
        break;
      }
      content.push(line);
    }
  }

  // Trim leading/trailing blank lines
  while (content.length > 0 && content[0].trim() === "") content.shift();
  while (content.length > 0 && content[content.length - 1].trim() === "") content.pop();
  return content.join("\n");
}

/**
 * Replace a section's content in markdown, preserving structure.
 * Matches iOS PromptParser.replaceSection().
 * @param {string} markdown
 * @param {string} header
 * @param {string} newContent
 * @returns {string}
 */
function replaceSection(markdown, header, newContent) {
  const lines = markdown.split("\n");
  const result = [];
  let skipping = false;

  for (const line of lines) {
    if (line.includes(header) && line.includes("DO NOT EDIT/DELETE THIS SECTION HEADER")) {
      result.push(line);
      result.push(newContent);
      skipping = true;
      continue;
    }
    if (skipping) {
      if ((line.startsWith("# ") && line.includes("DO NOT EDIT/DELETE THIS SECTION HEADER"))
          || line.includes("====END USER INSTRUCTIONS====")) {
        result.push("");
        result.push(line);
        skipping = false;
      }
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}

/**
 * 3-way merge for a flat bullet list.
 * @param {string[]} baseBullets
 * @param {string[]} localBullets
 * @param {string[]} remoteBullets
 * @returns {string[]} Merged bullets
 */
function mergeBullets(baseBullets, localBullets, remoteBullets) {
  const baseSet = new Set(baseBullets);
  const remoteSet = new Set(remoteBullets);

  const remoteRemoved = new Set([...baseSet].filter((b) => !remoteSet.has(b)));
  const remoteAdded = new Set([...remoteSet].filter((b) => !baseSet.has(b)));

  // Start with local (preserves local ordering + local changes)
  const result = localBullets.filter((b) => !remoteRemoved.has(b));

  // Append remote additions not already present
  const resultSet = new Set(result);
  for (const bullet of remoteBullets) {
    if (remoteAdded.has(bullet) && !resultSet.has(bullet)) {
      result.push(bullet);
      resultSet.add(bullet);
    }
  }

  return result;
}

/**
 * 3-way merge for a sectioned markdown field (composition or action).
 * Merges bullets per section independently, preserving markdown structure.
 * @param {string} base - Base state (last synced)
 * @param {string} local - Current local state
 * @param {string} remote - Incoming remote state
 * @param {string[]} sectionHeaders - Section header strings
 * @returns {string} Merged markdown
 */
export function mergeSectionedField(base, local, remote, sectionHeaders) {
  let result = local;
  let totalChanges = 0;

  for (const header of sectionHeaders) {
    const baseBullets = extractBullets(extractSection(base, header));
    const localBullets = extractBullets(extractSection(local, header));
    const remoteBullets = extractBullets(extractSection(remote, header));

    const merged = mergeBullets(baseBullets, localBullets, remoteBullets);

    // Only replace if something changed
    if (JSON.stringify(merged) !== JSON.stringify(localBullets)) {
      const newContent = merged.map((b) => `- ${b}`).join("\n");
      result = replaceSection(result, header, newContent);
      totalChanges += Math.abs(merged.length - localBullets.length);
    }
  }

  if (totalChanges > 0) {
    log(`${PFX}Sectioned merge: ${totalChanges} bullet changes across ${sectionHeaders.length} sections`);
  }
  return result;
}

/**
 * 3-way merge for a flat bullet field (kb).
 * @param {string} base - Base state (last synced)
 * @param {string} local - Current local state
 * @param {string} remote - Incoming remote state
 * @returns {string} Merged text
 */
export function mergeFlatField(base, local, remote) {
  const baseBullets = extractBullets(base);
  const localBullets = extractBullets(local);
  const remoteBullets = extractBullets(remote);

  const merged = mergeBullets(baseBullets, localBullets, remoteBullets);

  if (JSON.stringify(merged) === JSON.stringify(localBullets)) return local;

  log(`${PFX}Flat merge: ${localBullets.length} local → ${merged.length} merged (base: ${baseBullets.length}, remote: ${remoteBullets.length})`);
  return merged.map((b) => `- ${b}`).join("\n");
}

/** Section headers for composition markdown. */
export { COMPOSITION_SECTIONS, ACTION_SECTIONS };
