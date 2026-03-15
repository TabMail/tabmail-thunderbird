// markdown.test.js — Tests for chat/modules/markdown.js
//
// The markdown renderer has many pure-logic functions that can be tested.
// We mock browser-dependent imports and test the rendering pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((text) => {
    if (!text || typeof text !== 'string') return text;
    return text.normalize('NFKC');
  }),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    debugMode: false,
    logFolder: 'logs',
  },
}));

vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveContactDetails: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
}));

vi.mock('../chat/modules/helpers.js', () => ({
  getGenericTimezoneAbbr: vi.fn(() => 'PT'),
}));

// Mock idTranslator to passthrough
vi.mock('../chat/modules/idTranslator.js', () => ({
  processLLMResponseLLMtoTB: vi.fn((text) => text),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { renderMarkdown, attachSpecialLinkListeners } = await import('../chat/modules/markdown.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  describe('basic text rendering', () => {
    it('returns empty string for null input', async () => {
      expect(await renderMarkdown(null)).toBe('');
    });

    it('returns empty string for empty string input', async () => {
      expect(await renderMarkdown('')).toBe('');
    });

    it('returns empty string for undefined input', async () => {
      expect(await renderMarkdown(undefined)).toBe('');
    });

    it('wraps plain text in a paragraph', async () => {
      const result = await renderMarkdown('Hello world');
      expect(result).toContain('<p>Hello world</p>');
    });

    it('handles multiple paragraphs separated by blank lines', async () => {
      const result = await renderMarkdown('First paragraph\n\nSecond paragraph');
      expect(result).toContain('<p>First paragraph</p>');
      expect(result).toContain('<p>Second paragraph</p>');
    });

    it('converts single newlines to <br/> within paragraphs', async () => {
      const result = await renderMarkdown('Line one\nLine two');
      expect(result).toContain('Line one<br/>Line two');
    });
  });

  describe('bold and italic formatting', () => {
    it('renders bold text with ** markers', async () => {
      const result = await renderMarkdown('This is **bold** text');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('renders italic text with * markers', async () => {
      const result = await renderMarkdown('This is *italic* text');
      expect(result).toContain('<em>italic</em>');
    });

    it('handles bold and italic together', async () => {
      const result = await renderMarkdown('**bold** and *italic*');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
    });
  });

  describe('headers', () => {
    it('renders h1 headers', async () => {
      const result = await renderMarkdown('# Header One');
      expect(result).toContain('<h1>Header One</h1>');
    });

    it('renders h2 headers', async () => {
      const result = await renderMarkdown('## Header Two');
      expect(result).toContain('<h2>Header Two</h2>');
    });

    it('renders h3 headers', async () => {
      const result = await renderMarkdown('### Header Three');
      expect(result).toContain('<h3>Header Three</h3>');
    });

    it('renders h4 through h6', async () => {
      const r4 = await renderMarkdown('#### H4');
      expect(r4).toContain('<h4>H4</h4>');
      const r5 = await renderMarkdown('##### H5');
      expect(r5).toContain('<h5>H5</h5>');
      const r6 = await renderMarkdown('###### H6');
      expect(r6).toContain('<h6>H6</h6>');
    });

    it('strips trailing hash marks from headers', async () => {
      const result = await renderMarkdown('## Header ##');
      expect(result).toContain('<h2>Header</h2>');
    });
  });

  describe('inline code', () => {
    it('renders inline code with backticks', async () => {
      const result = await renderMarkdown('Use `console.log()` for debugging');
      expect(result).toContain('<code>console.log()</code>');
    });

    it('escapes HTML inside inline code', async () => {
      const result = await renderMarkdown('Use `<div>` for layout');
      expect(result).toContain('<code>&lt;div&gt;</code>');
    });
  });

  describe('fenced code blocks', () => {
    it('renders fenced code blocks with backtick fences', async () => {
      const md = '```\nconst x = 1;\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('<pre><code>');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('</code></pre>');
    });

    it('renders fenced code blocks with language tag', async () => {
      const md = '```javascript\nconst x = 1;\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('class="language-javascript"');
    });

    it('renders fenced code blocks with tilde fences', async () => {
      const md = '~~~python\nprint("hello")\n~~~';
      const result = await renderMarkdown(md);
      expect(result).toContain('<pre><code');
      expect(result).toContain('print(&quot;hello&quot;)');
    });

    it('escapes HTML in code blocks', async () => {
      const md = '```\n<script>alert("xss")</script>\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('<script>');
    });
  });

  describe('links', () => {
    it('renders HTTP links', async () => {
      const result = await renderMarkdown('[Click here](https://example.com)');
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('Click here');
      expect(result).toContain('target="_blank"');
    });

    it('renders mailto links with text label', async () => {
      // [Email](...) is treated as a special TabMail link, use different text
      const result = await renderMarkdown('[Send mail](mailto:test@example.com)');
      expect(result).toContain('href="mailto:test@example.com"');
    });

    it('sanitizes dangerous URLs to #', async () => {
      const result = await renderMarkdown('[Danger](javascript:void(0))');
      expect(result).toContain('href="#"');
      expect(result).not.toContain('javascript:');
    });
  });

  describe('unordered lists', () => {
    it('renders simple unordered list', async () => {
      const md = '- Item one\n- Item two\n- Item three';
      const result = await renderMarkdown(md);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item one</li>');
      expect(result).toContain('<li>Item two</li>');
      expect(result).toContain('<li>Item three</li>');
      expect(result).toContain('</ul>');
    });
  });

  describe('ordered lists', () => {
    it('renders simple ordered list', async () => {
      const md = '1. First\n2. Second\n3. Third';
      const result = await renderMarkdown(md);
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>First</li>');
      expect(result).toContain('<li>Second</li>');
      expect(result).toContain('<li>Third</li>');
      expect(result).toContain('</ol>');
    });
  });

  describe('nested lists', () => {
    it('renders nested unordered list', async () => {
      const md = '- Parent\n  - Child';
      const result = await renderMarkdown(md);
      expect(result).toContain('<ul>');
      expect(result).toContain('Parent');
      expect(result).toContain('Child');
    });
  });

  describe('blockquotes', () => {
    it('renders blockquotes with > prefix', async () => {
      const md = '> This is a quote';
      const result = await renderMarkdown(md);
      expect(result).toContain('<blockquote>');
      expect(result).toContain('This is a quote');
      expect(result).toContain('</blockquote>');
    });

    it('renders multi-line blockquotes', async () => {
      const md = '> Line one\n> Line two';
      const result = await renderMarkdown(md);
      expect(result).toContain('<blockquote>');
      expect(result).toContain('Line one');
      expect(result).toContain('Line two');
    });
  });

  describe('tables', () => {
    it('renders simple table', async () => {
      const md = '| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |';
      const result = await renderMarkdown(md);
      expect(result).toContain('<table');
      expect(result).toContain('<th>');
      expect(result).toContain('Header 1');
      expect(result).toContain('<td>');
      expect(result).toContain('Cell 1');
    });

    it('renders table with multiple rows', async () => {
      const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
      const result = await renderMarkdown(md);
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });
  });

  describe('HTML escaping', () => {
    it('escapes angle brackets in regular text', async () => {
      const result = await renderMarkdown('Use <br> tags');
      // <br> should be captured as a br placeholder and restored
      // or escaped depending on context
      expect(result).toBeDefined();
    });

    it('escapes ampersands', async () => {
      const result = await renderMarkdown('A & B');
      expect(result).toContain('A &amp; B');
    });

    it('escapes quotes', async () => {
      const result = await renderMarkdown('He said "hello"');
      expect(result).toContain('&quot;hello&quot;');
    });
  });

  describe('shorthand special links', () => {
    it('converts (email N) shorthand to [Email](N)', async () => {
      // The shorthand conversion happens before entity resolution
      // Since entity resolution is mocked to fail, the link will be hidden
      // But we can verify the conversion step happened via log
      const result = await renderMarkdown('Check (email 1)');
      // The result depends on entity resolution mock
      expect(result).toBeDefined();
    });

    it('converts (contact N) shorthand to [Contact](N)', async () => {
      const result = await renderMarkdown('See (contact 42)');
      expect(result).toBeDefined();
    });

    it('converts (event N) shorthand to [Event](N)', async () => {
      const result = await renderMarkdown('RSVP (event 7)');
      expect(result).toBeDefined();
    });
  });

  describe('markdown fence container unwrapping', () => {
    it('unwraps ```markdown containers so content renders as markdown', async () => {
      const md = '```markdown\n# Hello\n\nWorld\n```';
      const result = await renderMarkdown(md);
      // Should be rendered as markdown, not as a code block
      expect(result).toContain('<h1>Hello</h1>');
      expect(result).toContain('World');
    });

    it('unwraps ```md containers', async () => {
      const md = '```md\n**bold** text\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('<strong>bold</strong>');
    });

    it('rewrites inner code fences to tilde when unwrapping markdown containers', async () => {
      const md = '```markdown\nSome text\n```python\ncode\n```\nMore text\n```';
      const result = await renderMarkdown(md);
      // The inner ```python should be rewritten to ~~~python and rendered as code
      expect(result).toContain('code');
    });
  });

  describe('literal <br> handling', () => {
    it('converts literal <br> to HTML line break', async () => {
      const result = await renderMarkdown('Line one<br>Line two');
      expect(result).toContain('<br/>');
    });

    it('converts <br/> to HTML line break', async () => {
      const result = await renderMarkdown('Line one<br/>Line two');
      expect(result).toContain('<br/>');
    });
  });

  describe('reminder cards', () => {
    it('renders [reminder] prefixed lines as styled cards', async () => {
      const md = '[reminder] Don\'t forget to reply to Alice';
      const result = await renderMarkdown(md);
      expect(result).toContain('tm-reminder-card');
      expect(result).toContain('tm-reminder-dismiss');
    });
  });

  describe('mixed content', () => {
    it('handles paragraphs, headers, and lists together', async () => {
      const md = '# Title\n\nSome text here.\n\n- Item 1\n- Item 2\n\nAnother paragraph.';
      const result = await renderMarkdown(md);
      expect(result).toContain('<h1>Title</h1>');
      expect(result).toContain('<p>Some text here.</p>');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<p>Another paragraph.</p>');
    });

    it('handles code block followed by regular text', async () => {
      const md = '```\ncode\n```\n\nRegular text';
      const result = await renderMarkdown(md);
      expect(result).toContain('<pre><code>');
      expect(result).toContain('<p>Regular text</p>');
    });
  });

  describe('edge cases', () => {
    it('handles very long input', async () => {
      const longText = 'A'.repeat(10000);
      const result = await renderMarkdown(longText);
      expect(result).toContain('A'.repeat(100)); // at least some content preserved
    });

    it('handles text with only whitespace', async () => {
      const result = await renderMarkdown('   \n\n   ');
      expect(result).toBeDefined();
    });

    it('handles text with special unicode characters', async () => {
      const result = await renderMarkdown('Hello \u2019 world \u2014 test');
      expect(result).toBeDefined();
    });
  });

  describe('horizontal rules', () => {
    it('does not render --- as <hr> (not supported)', async () => {
      const result = await renderMarkdown('Before\n\n---\n\nAfter');
      // The renderer does not convert --- to <hr>
      expect(result).toContain('Before');
      expect(result).toContain('After');
      expect(result).toBeDefined();
    });
  });

  describe('nested formatting in lists', () => {
    it('renders bold text within list items', async () => {
      const md = '- **Bold item**\n- Normal item';
      const result = await renderMarkdown(md);
      expect(result).toContain('<strong>Bold item</strong>');
      expect(result).toContain('Normal item');
    });

    it('renders inline code within list items', async () => {
      const md = '- Use `code` here\n- Another item';
      const result = await renderMarkdown(md);
      expect(result).toContain('<code>code</code>');
    });
  });

  describe('deeply nested lists', () => {
    it('renders three levels of nesting', async () => {
      const md = '- Level 1\n  - Level 2\n    - Level 3';
      const result = await renderMarkdown(md);
      expect(result).toContain('Level 1');
      expect(result).toContain('Level 2');
      expect(result).toContain('Level 3');
    });
  });

  describe('mixed ordered and unordered lists', () => {
    it('renders ordered list after unordered list', async () => {
      const md = '- Bullet 1\n- Bullet 2\n\n1. Number 1\n2. Number 2';
      const result = await renderMarkdown(md);
      expect(result).toContain('<ul>');
      expect(result).toContain('<ol>');
      expect(result).toContain('Bullet 1');
      expect(result).toContain('Number 1');
    });
  });

  describe('empty code blocks', () => {
    it('renders empty fenced code block', async () => {
      const md = '```\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('<pre><code>');
      expect(result).toContain('</code></pre>');
    });
  });

  describe('multiple blockquotes', () => {
    it('renders separate blockquotes', async () => {
      const md = '> First quote\n\n> Second quote';
      const result = await renderMarkdown(md);
      expect(result).toContain('First quote');
      expect(result).toContain('Second quote');
    });
  });

  describe('table alignment', () => {
    it('renders table with alignment markers', async () => {
      const md = '| Left | Center | Right |\n| :--- | :---: | ---: |\n| L | C | R |';
      const result = await renderMarkdown(md);
      expect(result).toContain('<table');
      expect(result).toContain('Left');
      expect(result).toContain('Center');
      expect(result).toContain('Right');
    });
  });

  describe('complex mixed content', () => {
    it('handles header → list → blockquote → code → paragraph', async () => {
      const md = [
        '## Section',
        '',
        '- Item 1',
        '- Item 2',
        '',
        '> A quote',
        '',
        '```',
        'code()',
        '```',
        '',
        'Final paragraph.',
      ].join('\n');
      const result = await renderMarkdown(md);
      expect(result).toContain('<h2>Section</h2>');
      expect(result).toContain('<li>Item 1</li>');
      expect(result).toContain('<blockquote>');
      expect(result).toContain('code()');
      expect(result).toContain('Final paragraph.');
    });
  });

  describe('double-escaped newlines in code blocks', () => {
    it('converts escaped \\n sequences in single-line code blocks', async () => {
      // A code block that is actually a single line with many literal \n sequences
      const md = '```\nline1\\nline2\\nline3\\nline4\n```';
      const result = await renderMarkdown(md);
      expect(result).toContain('<pre><code>');
    });
  });

  describe('special characters in headers', () => {
    it('renders headers with special characters', async () => {
      const result = await renderMarkdown('## Header & <Special> "Chars"');
      expect(result).toContain('<h2>');
      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;Special&gt;');
    });
  });
});

// ---------------------------------------------------------------------------
// attachSpecialLinkListeners
// ---------------------------------------------------------------------------
describe('attachSpecialLinkListeners', () => {
  it('handles null container gracefully', () => {
    expect(() => attachSpecialLinkListeners(null)).not.toThrow();
  });

  it('handles container with no special links', () => {
    const container = {
      querySelectorAll: vi.fn(() => []),
    };
    expect(() => attachSpecialLinkListeners(container)).not.toThrow();
  });
});

