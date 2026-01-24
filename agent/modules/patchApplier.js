import { log, normalizeUnicode } from "./utils.js";

const PFX = "[PatchApplier] ";

/**
 * Parse multiple ADD/DEL operations from patch text
 * @param {string} patchText - Patch text with operations
 * @param {string} type - Either "action" or "kb" for different parsing rules
 * @returns {Array} Array of operation objects
 */
function parseMultipleOperations(patchText, type = "action") {
    const operations = [];
    const lines = patchText.trim().split('\n');
    let i = 0;
    
    while (i < lines.length) {
        const operation = lines[i].trim().toUpperCase();
        
        if (!['ADD', 'DEL'].includes(operation)) {
            i++;
            continue;
        }
        
        let actionType = null;
        let contentStartIndex = i + 1;
        
        if (type === "action") {
            // Action rules require action type on next line
            if (i + 2 >= lines.length) {
                log(`${PFX}Incomplete action operation at line ${i + 1}`, "warn");
                break;
            }
            actionType = lines[i + 1].trim().toLowerCase();
            contentStartIndex = i + 2;
        } else if (type === "kb") {
            // KB operations go directly to content
            if (i + 1 >= lines.length) {
                log(`${PFX}Incomplete KB operation at line ${i + 1}`, "warn");
                break;
            }
        }
        
        // Find the content text (everything until next operation or end)
        let contentLines = [];
        let j = contentStartIndex;
        while (j < lines.length) {
            const nextLine = lines[j].trim().toUpperCase();
            if (['ADD', 'DEL'].includes(nextLine)) {
                break;
            }
            contentLines.push(lines[j]);
            j++;
        }
        
        if (contentLines.length === 0) {
            log(`${PFX}Empty content for ${operation} operation`, "warn");
            i = j;
            continue;
        }
        
        const content = contentLines.join('\n').trim();
        
        if (type === "action") {
            operations.push({
                operation,
                actionType,
                content
            });
        } else {
            operations.push({
                operation,
                content
            });
        }
        
        i = j;
    }
    
    return operations;
}

/**
 * Normalize text to ensure proper markdown bullet and sentence ending
 * @param {string} text - Text to normalize
 * @returns {string} Normalized text with bullet and period
 */
function normalizeContent(text) {
    // Remove existing bullet if present
    let normalized = text.startsWith('- ') ? text.substring(2).trim() : text.trim();
    
    // Add period if missing
    if (!normalized.endsWith('.')) {
        normalized += '.';
    }
    
    // Return with markdown bullet
    return `- ${normalized}`;
}

/**
 * Check if content already exists (case-insensitive with Unicode normalization)
 * @param {Array} contentLines - Array of file lines
 * @param {string} normalizedContent - Normalized content to check
 * @returns {boolean} True if duplicate found
 */
function isDuplicate(contentLines, normalizedContent) {
    const normalizedText = normalizedContent.toLowerCase().trim();
    return contentLines.some(line => {
        const lineNormalized = normalizeUnicode(line).toLowerCase().trim();
        return lineNormalized === normalizedText;
    });
}

/**
 * Apply a single operation (unified for both action rules and knowledge base)
 * @param {string} content - Current file content
 * @param {string} operation - ADD or DEL
 * @param {string} contentText - Content text to add/remove
 * @param {string|null} actionType - delete, archive, reply, none, or null for KB operations
 * @returns {string|null} Updated content or null if failed
 */
function applySingleOperation(content, operation, contentText, actionType = null) {
    try {
        log(`${PFX}applySingleOperation called:`);
        log(`${PFX}  operation: ${JSON.stringify(operation)}`);
        log(`${PFX}  contentText: ${JSON.stringify(contentText)}`);
        log(`${PFX}  actionType: ${JSON.stringify(actionType)}`);
        log(`${PFX}  content length: ${content.length}`);
        
        // Validate action type if provided
        if (actionType !== null && !['delete', 'archive', 'reply', 'none'].includes(actionType)) {
            log(`${PFX}Invalid action type: ${actionType}`, "warn");
            return null;
        }
        
        if (!contentText) {
            log(`${PFX}Empty content text`, "warn");
            return null;
        }
        
        const normalizedContent = normalizeContent(contentText);
        const contentLines = content.split('\n');
        
        if (operation === 'ADD') {
            // Check for duplicates
            if (isDuplicate(contentLines, normalizedContent)) {
                log(`${PFX}Duplicate content detected, skipping: ${normalizedContent}`, "warn");
                return content;
            }
            
            if (actionType !== null) {
                // Action operation - find section header and insert within section
                const sectionHeader = `# Emails to be marked as \`${actionType}\` (DO NOT EDIT/DELETE THIS SECTION HEADER)`;
                
                // Find section header
                let sectionIndex = -1;
                for (let i = 0; i < contentLines.length; i++) {
                    if (contentLines[i].trim() === sectionHeader) {
                        sectionIndex = i;
                        break;
                    }
                }
                
                if (sectionIndex === -1) {
                    log(`${PFX}Section not found: ${sectionHeader}`, "warn");
                    return null;
                }
                
                // Find end of section (before next section header or end of file)
                let insertIndex = sectionIndex + 1;
                for (let i = sectionIndex + 1; i < contentLines.length; i++) {
                    const line = contentLines[i].trim();
                    // If we hit another section header, stop here
                    if (line.startsWith('# ') && line.includes('Emails to be marked as')) {
                        break;
                    }
                    // If line is a rule (starts with -), continue
                    if (line.startsWith('- ')) {
                        insertIndex = i + 1;
                    }
                }
                
                // Insert at end of section
                contentLines.splice(insertIndex, 0, normalizedContent);
                
            } else {
                // KB operation - treat section header as being at the very top, append to end
                contentLines.push(normalizedContent);
            }
            
        } else if (operation === 'DEL') {
            // Find and remove the specific content (case-insensitive)
            // Normalize by removing trailing periods from both sides for comparison
            // since KB entries may or may not have periods
            let contentRemoved = false;
            const normalizedContentForComparison = normalizedContent.trim().toLowerCase().replace(/\.$/, '');
            
            log(`${PFX}DEL operation details:`);
            log(`${PFX}  Original content text: ${JSON.stringify(contentText)}`);
            log(`${PFX}  Normalized content: ${JSON.stringify(normalizedContent)}`);
            log(`${PFX}  Comparison text: ${JSON.stringify(normalizedContentForComparison)}`);
            log(`${PFX}  Comparison length: ${normalizedContentForComparison.length}`);
            
            for (let i = 0; i < contentLines.length; i++) {
                let lineForComparison = normalizeUnicode(contentLines[i]).trim().toLowerCase();
                // Strip trailing period for consistent comparison
                lineForComparison = lineForComparison.replace(/\.$/, '');
                
                if (contentLines[i].trim().startsWith('- ')) {
                    log(`${PFX}  Comparing against [${i}]: ${JSON.stringify(lineForComparison)} (len=${lineForComparison.length})`);
                    
                    if (lineForComparison === normalizedContentForComparison) {
                        const removedLine = contentLines[i];
                        contentLines.splice(i, 1);
                        contentRemoved = true;
                        log(`${PFX}Successfully removed content: ${removedLine}`);
                        break;
                    } else {
                        // Show character-by-character diff for close matches
                        if (Math.abs(lineForComparison.length - normalizedContentForComparison.length) <= 3) {
                            log(`${PFX}  Close match diff analysis:`);
                            const maxLen = Math.max(lineForComparison.length, normalizedContentForComparison.length);
                            for (let j = 0; j < maxLen; j++) {
                                const c1 = lineForComparison[j] || 'EOF';
                                const c2 = normalizedContentForComparison[j] || 'EOF';
                                if (c1 !== c2) {
                                    log(`${PFX}    Diff at pos ${j}: '${c1}' (${c1.charCodeAt ? c1.charCodeAt(0) : 'N/A'}) vs '${c2}' (${c2.charCodeAt ? c2.charCodeAt(0) : 'N/A'})`);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            
            if (!contentRemoved) {
                log(`${PFX}Content not found for deletion: ${normalizedContent}`, "warn");
                log(`${PFX}Available content for comparison:`, "debug");
                contentLines.forEach((line, i) => {
                    if (line.trim().startsWith('- ')) {
                        log(`${PFX}  [${i}] ${JSON.stringify(line.trim())} (len=${line.trim().length})`);
                    }
                });
                return null;
            }
        }
        
        log(`${PFX}Successful operation, returning updated content (${contentLines.length} lines)`);
        return contentLines.join('\n');
        
    } catch (e) {
        log(`${PFX}Error applying operation: ${e}`, "error");
        return null;
    }
}

/**
 * Apply a single action rule operation (legacy wrapper)
 * @param {string} content - Current file content
 * @param {string} operation - ADD or DEL
 * @param {string} actionType - delete, archive, reply, or none
 * @param {string} ruleText - Rule text content
 * @returns {string|null} Updated content or null if failed
 */
function applySingleActionOperation(content, operation, actionType, ruleText) {
    return applySingleOperation(content, operation, ruleText, actionType);
}

/**
 * Apply a single knowledge base operation (legacy wrapper)
 * @param {string} content - Current file content
 * @param {string} operation - ADD or DEL
 * @param {string} knowledgeText - Knowledge text content
 * @returns {string|null} Updated content or null if failed
 */
function applySingleKBOperation(content, operation, knowledgeText) {
    return applySingleOperation(content, operation, knowledgeText, null);
}

/**
 * Apply action rules patch with multiple operations
 * @param {string} content - Current user_action.md content
 * @param {string} patchText - Patch text with ADD/DEL operations
 * @returns {string|null} Updated content or null if failed
 */
export function applyActionPatch(content, patchText) {
    try {
        const operations = parseMultipleOperations(patchText, "action");
        
        if (operations.length === 0) {
            log(`${PFX}No valid action operations found in patch`, "warn");
            return null;
        }
        
        log(`${PFX}Processing ${operations.length} action operation(s)`);
        
        let currentContent = content;
        for (const op of operations) {
            log(`${PFX}Applying action ${op.operation} for ${op.actionType}: ${op.content.substring(0, 50)}...`);
            currentContent = applySingleActionOperation(currentContent, op.operation, op.actionType, op.content);
            if (currentContent === null) {
                log(`${PFX}Failed to apply action ${op.operation} operation`, "error");
                return null;
            }
        }
        
        return currentContent;
        
    } catch (e) {
        log(`${PFX}Error applying action patch: ${e}`, "error");
        return null;
    }
}

/**
 * Apply knowledge base patch with multiple operations
 * @param {string} content - Current user_kb.md content
 * @param {string} patchText - Patch text with ADD/DEL operations
 * @returns {string|null} Updated content or null if failed
 */
export function applyKBPatch(content, patchText) {
    try {
        log(`${PFX}applyKBPatch called with patch: ${JSON.stringify(patchText)}`);
        const operations = parseMultipleOperations(patchText, "kb");
        
        log(`${PFX}Parsed ${operations.length} operations:`);
        operations.forEach((op, i) => {
            log(`${PFX}  Op[${i}]: ${op.operation} - ${JSON.stringify(op.content)}`);
        });
        
        if (operations.length === 0) {
            log(`${PFX}No valid KB operations found in patch`, "warn");
            return null;
        }
        
        log(`${PFX}Processing ${operations.length} KB operation(s)`);
        
        let currentContent = content;
        for (const op of operations) {
            log(`${PFX}Applying KB ${op.operation}: ${op.content.substring(0, 50)}...`);
            currentContent = applySingleKBOperation(currentContent, op.operation, op.content);
            if (currentContent === null) {
                log(`${PFX}Failed to apply KB ${op.operation} operation`, "error");
                return null;
            }
        }
        
        return currentContent;
        
    } catch (e) {
        log(`${PFX}Error applying KB patch: ${e}`, "error");
        return null;
    }
}
