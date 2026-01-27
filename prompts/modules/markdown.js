/**
 * Markdown parsing and reconstruction for prompts
 */

/**
 * Parse markdown into structured data
 */
export function parseMarkdown(content, isComposition) {
    const lines = content.split("\n");
    const sections = [];
    let currentSection = null;
    let currentTemplate = null;
    let preContent = [];
    let inSections = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for section header with DO NOT EDIT marker
        const sectionMatch = line.match(/^#\s+(.+?)\s*\(DO NOT EDIT\/DELETE THIS SECTION HEADER\)/);
        if (sectionMatch) {
            inSections = true;
            const title = sectionMatch[1];
            
            // Save previous section
            if (currentSection) {
                if (currentTemplate) {
                    currentSection.templates.push(currentTemplate);
                    currentTemplate = null;
                }
                // Trim content to remove extra whitespace
                if (currentSection.content) {
                    currentSection.content = currentSection.content.trim();
                }
                sections.push(currentSection);
            }
            
            currentSection = {
                title,
                type: "templates", // Will determine type based on content
                templates: [],
                content: "",
            };
            continue;
        }
        
        // Check for regular section header (# without DO NOT EDIT)
        const regularSectionMatch = line.match(/^#\s+(.+)/);
        if (regularSectionMatch && !inSections) {
            // This is pre-content section, add to preContent
            preContent.push(line);
            continue;
        }
        
        // Collect pre-content (everything before first DO NOT EDIT section)
        if (!inSections) {
            preContent.push(line);
            continue;
        }
        
        // Skip if no current section
        if (!currentSection) {
            continue;
        }
        
        // Check for template header (##)
        const templateMatch = line.match(/^##\s+(.+)/);
        if (templateMatch) {
            const title = templateMatch[1].trim();
            
            // Save previous template
            if (currentTemplate) {
                currentSection.templates.push(currentTemplate);
            }
            
            currentTemplate = {
                title,
                instructions: [],
                exampleReply: "",
            };
            continue;
        }
        
        // Parse template content if we're in a template
        if (currentTemplate) {
            // Check for bullet points (instructions)
            if (line.match(/^-\s+(.+)/)) {
                const instruction = line.match(/^-\s+(.+)/)[1];
                // Skip "Example reply:" line - don't add as instruction
                if (!instruction.match(/^Example reply:/i)) {
                    currentTemplate.instructions.push(instruction);
                }
            }
            
            // Check for code block start (example reply)
            else if (line.trim() === "```") {
                // Find the end of code block
                let exampleLines = [];
                i++;
                while (i < lines.length && lines[i].trim() !== "```") {
                    exampleLines.push(lines[i]);
                    i++;
                }
                currentTemplate.exampleReply = exampleLines.join("\n");
            }
            continue;
        }
        
        // If no template, add to section content (for simple sections)
        if (currentSection && !currentTemplate) {
            // Stop parsing when we hit the END marker
            if (line.trim() === "====END USER INSTRUCTIONS====") {
                // Save current section and stop processing
                if (currentTemplate) {
                    currentSection.templates.push(currentTemplate);
                    currentTemplate = null;
                }
                // Trim content to remove extra whitespace
                if (currentSection.content) {
                    currentSection.content = currentSection.content.trim();
                }
                sections.push(currentSection);
                currentSection = null;
                // Skip the rest of the file
                break;
            }
            
            if (currentSection.content) {
                currentSection.content += "\n" + line;
            } else {
                currentSection.content = line;
            }
        }
    }
    
    // Save last section/template if not already saved
    if (currentTemplate && currentSection) {
        currentSection.templates.push(currentTemplate);
    }
    if (currentSection) {
        // Trim content to remove extra whitespace
        if (currentSection.content) {
            currentSection.content = currentSection.content.trim();
        }
        sections.push(currentSection);
    }
    
    return {
        preContent: preContent.join("\n"),
        sections,
    };
}

/**
 * Reconstruct markdown from structured data
 */
export function reconstructMarkdown(data, isComposition) {
    let lines = [];
    
    // Add pre-content
    if (data.preContent) {
        lines.push(data.preContent);
    }
    
    // Add sections
    for (const section of data.sections) {
        lines.push("");
        lines.push(`# ${section.title} (DO NOT EDIT/DELETE THIS SECTION HEADER)`);
        
        if (isComposition && section.templates && section.templates.length > 0) {
            // Reconstruct templates
            for (const template of section.templates) {
                lines.push("");
                lines.push(`## ${template.title}`);
                
                // Add instructions
                for (const instruction of template.instructions) {
                    lines.push(`- ${instruction}`);
                }
                
                // Add example reply marker
                if (template.exampleReply && template.exampleReply.trim()) {
                    lines.push("- Example reply:");
                    lines.push("```");
                    lines.push(template.exampleReply);
                    lines.push("```");
                }
            }
        } else {
            // Simple content - trim to avoid extra newlines
            const content = (section.content || "").trim();
            if (content) {
                lines.push(content);
            }
        }
    }
    
    // Add ending markers for composition prompts
    if (isComposition) {
        lines.push("");
        lines.push("====END USER INSTRUCTIONS====");
        lines.push("");
        lines.push("Now, acknowledge these user instructions and do not deviate from them.");
    }
    
    return lines.join("\n");
}
