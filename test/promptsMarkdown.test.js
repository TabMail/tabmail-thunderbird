// promptsMarkdown.test.js — Tests for prompts/modules/markdown.js
//
// Pure functions: parseMarkdown, reconstructMarkdown
// These handle the structured markdown format for user prompt editing.

import { describe, it, expect } from 'vitest';

const { parseMarkdown, reconstructMarkdown } = await import('../prompts/modules/markdown.js');

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SIMPLE_PROMPT = `# My Prompt

Some pre-content here.

# Templates (DO NOT EDIT/DELETE THIS SECTION HEADER)

## Greeting
- Be friendly
- Use first name
- Example reply:
\`\`\`
Hi there!
\`\`\`

## Farewell
- Be warm
- Wish them well`;

const SIMPLE_CONTENT_SECTION = `Some intro text

# Knowledge Base (DO NOT EDIT/DELETE THIS SECTION HEADER)
I like coffee.
I work at Acme Corp.

# Reminders (DO NOT EDIT/DELETE THIS SECTION HEADER)
Remember to follow up with Alice.`;

const COMPOSITION_PROMPT = `# Email Style

Write emails in my style.

# Reply Templates (DO NOT EDIT/DELETE THIS SECTION HEADER)

## Quick Acknowledge
- Keep it brief
- Express thanks
- Example reply:
\`\`\`
Thanks for the update!
\`\`\`

## Detailed Response
- Be thorough
- Address all points

====END USER INSTRUCTIONS====

Now, acknowledge these user instructions and do not deviate from them.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseMarkdown', () => {
  describe('basic parsing', () => {
    it('returns preContent and sections', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      expect(result.preContent).toBeDefined();
      expect(Array.isArray(result.sections)).toBe(true);
    });

    it('extracts pre-content before first section', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      expect(result.preContent).toContain('# My Prompt');
      expect(result.preContent).toContain('Some pre-content here.');
    });

    it('extracts sections with DO NOT EDIT marker', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].title).toBe('Templates');
    });

    it('extracts templates within sections', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      const section = result.sections[0];
      expect(section.templates.length).toBe(2);
      expect(section.templates[0].title).toBe('Greeting');
      expect(section.templates[1].title).toBe('Farewell');
    });

    it('extracts template instructions', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      const greeting = result.sections[0].templates[0];
      expect(greeting.instructions).toContain('Be friendly');
      expect(greeting.instructions).toContain('Use first name');
    });

    it('does not include "Example reply:" as instruction', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      const greeting = result.sections[0].templates[0];
      const hasExampleLine = greeting.instructions.some(i => i.match(/^Example reply/i));
      expect(hasExampleLine).toBe(false);
    });

    it('extracts example reply from code block', () => {
      const result = parseMarkdown(SIMPLE_PROMPT, false);
      const greeting = result.sections[0].templates[0];
      expect(greeting.exampleReply).toBe('Hi there!');
    });
  });

  describe('content sections', () => {
    it('parses multiple content sections', () => {
      const result = parseMarkdown(SIMPLE_CONTENT_SECTION, false);
      expect(result.sections.length).toBe(2);
      expect(result.sections[0].title).toBe('Knowledge Base');
      expect(result.sections[1].title).toBe('Reminders');
    });

    it('extracts section content', () => {
      const result = parseMarkdown(SIMPLE_CONTENT_SECTION, false);
      expect(result.sections[0].content).toContain('I like coffee');
      expect(result.sections[0].content).toContain('I work at Acme Corp');
    });
  });

  describe('composition prompts', () => {
    it('stops parsing at END marker', () => {
      const result = parseMarkdown(COMPOSITION_PROMPT, true);
      // Should not include content after the END marker
      const allContent = JSON.stringify(result);
      expect(allContent).not.toContain('acknowledge these user instructions');
    });

    it('extracts templates from composition prompt', () => {
      const result = parseMarkdown(COMPOSITION_PROMPT, true);
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].templates.length).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = parseMarkdown('', false);
      expect(result.preContent).toBe('');
      expect(result.sections).toEqual([]);
    });

    it('handles text with no sections', () => {
      const result = parseMarkdown('Just some plain text.\nNothing special.', false);
      expect(result.preContent).toContain('Just some plain text');
      expect(result.sections).toEqual([]);
    });

    it('handles section with no templates', () => {
      const md = '# Section (DO NOT EDIT/DELETE THIS SECTION HEADER)\nSome content here.';
      const result = parseMarkdown(md, false);
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].content).toContain('Some content here');
    });

    it('handles template with no instructions', () => {
      const md = '# Section (DO NOT EDIT/DELETE THIS SECTION HEADER)\n\n## Empty Template\n';
      const result = parseMarkdown(md, false);
      expect(result.sections[0].templates.length).toBe(1);
      expect(result.sections[0].templates[0].instructions).toEqual([]);
    });

    it('handles template with no example reply', () => {
      const md = '# Section (DO NOT EDIT/DELETE THIS SECTION HEADER)\n\n## Template\n- Instruction one\n- Instruction two';
      const result = parseMarkdown(md, false);
      const template = result.sections[0].templates[0];
      expect(template.instructions.length).toBe(2);
      expect(template.exampleReply).toBe('');
    });

    it('handles END marker inside a content section (non-composition)', () => {
      const md = `# Content (DO NOT EDIT/DELETE THIS SECTION HEADER)
Some stuff here.
====END USER INSTRUCTIONS====
This should be ignored.`;
      const result = parseMarkdown(md, false);
      expect(result.sections.length).toBe(1);
      expect(result.sections[0].content).toContain('Some stuff here');
      // Content after END marker should not appear
      const allContent = JSON.stringify(result);
      expect(allContent).not.toContain('This should be ignored');
    });

    it('handles multiple sections where second section has content after END marker', () => {
      const md = `# First (DO NOT EDIT/DELETE THIS SECTION HEADER)
First content.

# Second (DO NOT EDIT/DELETE THIS SECTION HEADER)
Second content.
====END USER INSTRUCTIONS====
Should be cut off.`;
      const result = parseMarkdown(md, false);
      expect(result.sections.length).toBe(2);
      expect(result.sections[0].content).toContain('First content');
      expect(result.sections[1].content).toContain('Second content');
      const allContent = JSON.stringify(result);
      expect(allContent).not.toContain('Should be cut off');
    });

    it('handles code block that extends to end of input', () => {
      const md = `# Section (DO NOT EDIT/DELETE THIS SECTION HEADER)

## Template
- Instruction
- Example reply:
\`\`\`
Unclosed code block content`;
      const result = parseMarkdown(md, false);
      const template = result.sections[0].templates[0];
      expect(template.exampleReply).toContain('Unclosed code block content');
    });

    it('handles template with multiple instructions and multiline example', () => {
      const md = `# Templates (DO NOT EDIT/DELETE THIS SECTION HEADER)

## Multi
- First instruction
- Second instruction
- Third instruction
- Example reply:
\`\`\`
Line 1
Line 2
Line 3
\`\`\``;
      const result = parseMarkdown(md, false);
      const template = result.sections[0].templates[0];
      expect(template.instructions.length).toBe(3);
      expect(template.exampleReply).toContain('Line 1');
      expect(template.exampleReply).toContain('Line 3');
    });
  });
});

describe('reconstructMarkdown', () => {
  it('reconstructs simple content sections', () => {
    const data = parseMarkdown(SIMPLE_CONTENT_SECTION, false);
    const rebuilt = reconstructMarkdown(data, false);
    expect(rebuilt).toContain('# Knowledge Base (DO NOT EDIT/DELETE THIS SECTION HEADER)');
    expect(rebuilt).toContain('I like coffee');
    expect(rebuilt).toContain('# Reminders (DO NOT EDIT/DELETE THIS SECTION HEADER)');
  });

  it('reconstructs composition prompts with templates', () => {
    const data = parseMarkdown(COMPOSITION_PROMPT, true);
    const rebuilt = reconstructMarkdown(data, true);
    expect(rebuilt).toContain('## Quick Acknowledge');
    expect(rebuilt).toContain('- Keep it brief');
    expect(rebuilt).toContain('```\nThanks for the update!\n```');
    expect(rebuilt).toContain('====END USER INSTRUCTIONS====');
  });

  it('includes pre-content', () => {
    const data = parseMarkdown(SIMPLE_PROMPT, false);
    const rebuilt = reconstructMarkdown(data, false);
    expect(rebuilt).toContain('# My Prompt');
  });

  it('adds END marker for composition prompts', () => {
    const data = {
      preContent: '',
      sections: [{ title: 'Test', templates: [], content: 'Hello' }],
    };
    const rebuilt = reconstructMarkdown(data, true);
    expect(rebuilt).toContain('====END USER INSTRUCTIONS====');
    expect(rebuilt).toContain('acknowledge these user instructions');
  });

  it('does not add END marker for non-composition', () => {
    const data = {
      preContent: '',
      sections: [{ title: 'Test', templates: [], content: 'Hello' }],
    };
    const rebuilt = reconstructMarkdown(data, false);
    expect(rebuilt).not.toContain('====END USER INSTRUCTIONS====');
  });

  describe('round-trip', () => {
    it('content section round-trips correctly', () => {
      const data = parseMarkdown(SIMPLE_CONTENT_SECTION, false);
      const rebuilt = reconstructMarkdown(data, false);
      const reparsed = parseMarkdown(rebuilt, false);
      expect(reparsed.sections.length).toBe(data.sections.length);
      for (let i = 0; i < data.sections.length; i++) {
        expect(reparsed.sections[i].title).toBe(data.sections[i].title);
        expect(reparsed.sections[i].content.trim()).toBe(data.sections[i].content.trim());
      }
    });

    it('composition prompt round-trips correctly', () => {
      const data = parseMarkdown(COMPOSITION_PROMPT, true);
      const rebuilt = reconstructMarkdown(data, true);
      const reparsed = parseMarkdown(rebuilt, true);
      expect(reparsed.sections.length).toBe(data.sections.length);
      expect(reparsed.sections[0].templates.length).toBe(data.sections[0].templates.length);
      for (let i = 0; i < data.sections[0].templates.length; i++) {
        const orig = data.sections[0].templates[i];
        const recon = reparsed.sections[0].templates[i];
        expect(recon.title).toBe(orig.title);
        expect(recon.instructions).toEqual(orig.instructions);
        expect(recon.exampleReply.trim()).toBe(orig.exampleReply.trim());
      }
    });
  });
});
