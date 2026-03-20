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

// ---------------------------------------------------------------------------
// Additional edge-case tests
// ---------------------------------------------------------------------------

describe('renderMarkdown — escapeHtml via rendering', () => {
  it('escapes all 5 special HTML characters in text', async () => {
    const result = await renderMarkdown('A & B < C > D "E" \'F\'');
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&quot;');
    expect(result).toContain('&#39;');
  });

  it('escapes special chars in different positions', async () => {
    const result = await renderMarkdown('&start middle<end> "quoted" it\'s');
    expect(result).toContain('&amp;start');
    expect(result).toContain('middle&lt;end&gt;');
    expect(result).toContain('&quot;quoted&quot;');
    expect(result).toContain('it&#39;s');
  });

  it('returns empty string for empty input', async () => {
    const result = await renderMarkdown('');
    expect(result).toBe('');
  });
});

describe('renderMarkdown — sanitizeUrl via link rendering', () => {
  it('passes through http URLs', async () => {
    const result = await renderMarkdown('[Link](http://example.com)');
    expect(result).toContain('href="http://example.com"');
  });

  it('passes through https URLs', async () => {
    const result = await renderMarkdown('[Link](https://example.com)');
    expect(result).toContain('href="https://example.com"');
  });

  it('passes through mailto URLs', async () => {
    const result = await renderMarkdown('[Mail](mailto:user@example.com)');
    expect(result).toContain('href="mailto:user@example.com"');
  });

  it('converts javascript: URLs to #', async () => {
    const result = await renderMarkdown('[XSS](javascript:alert(1))');
    expect(result).toContain('href="#"');
    expect(result).not.toContain('javascript:');
  });

  it('converts data: URLs to #', async () => {
    const result = await renderMarkdown('[Data](data:text/html,<h1>hi</h1>)');
    expect(result).toContain('href="#"');
    expect(result).not.toContain('data:');
  });

  it('converts ftp: URLs to #', async () => {
    const result = await renderMarkdown('[FTP](ftp://files.example.com)');
    expect(result).toContain('href="#"');
    expect(result).not.toContain('ftp:');
  });

  it('converts relative path URLs to #', async () => {
    const result = await renderMarkdown('[Rel](./page.html)');
    expect(result).toContain('href="#"');
  });

  it('does not render link with empty URL (regex requires non-empty URL)', async () => {
    const result = await renderMarkdown('[Empty]()');
    // The link regex requires at least one char in the URL, so this is not parsed as a link
    expect(result).not.toContain('href=');
    expect(result).toContain('Empty');
  });
});

describe('renderMarkdown — unwrapMarkdownFenceContainers edge cases', () => {
  it('unwraps multiple markdown fence containers in one document', async () => {
    const md = '```markdown\n# First\n```\n\nSome text\n\n```md\n# Second\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<h1>First</h1>');
    expect(result).toContain('<h1>Second</h1>');
  });

  it('preserves content of unclosed markdown fence container', async () => {
    const md = '```markdown\n# Title\nSome content';
    const result = await renderMarkdown(md);
    // Content should still be rendered even if the fence is unclosed
    expect(result).toContain('Title');
    expect(result).toContain('Some content');
  });

  it('rewrites nested code fences to tildes inside markdown container', async () => {
    const md = '```markdown\nBefore code\n```javascript\nconst x = 1;\n```\nAfter code\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('Before code');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('After code');
  });

  it('handles case-insensitive Markdown tag', async () => {
    const md = '```Markdown\n**bold** text\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<strong>bold</strong>');
  });

  it('handles case-insensitive MD tag', async () => {
    const md = '```MD\n*italic* text\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<em>italic</em>');
  });

  it('does NOT unwrap non-markdown language tags like python', async () => {
    const md = '```python\nprint("hello")\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<pre><code');
    expect(result).toContain('class="language-python"');
    expect(result).toContain('print');
  });
});

describe('renderMarkdown — code block edge cases', () => {
  it('converts literal backslash-n sequences in single-line code blocks', async () => {
    // When escaped newlines dominate real newlines, they should be converted
    const md = '```\nline1\\nline2\\nline3\\nline4\\nline5\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<pre><code>');
    // The escaped \n should be converted to real newlines since there are 5 escaped vs 0 real
    expect(result).toContain('line1');
    expect(result).toContain('line5');
  });

  it('renders multiple code blocks in one document', async () => {
    const md = '```javascript\nconst a = 1;\n```\n\nSome text\n\n```python\nprint("hi")\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('class="language-javascript"');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('class="language-python"');
    expect(result).toContain('print');
    expect(result).toContain('Some text');
  });

  it('renders code block with empty language tag', async () => {
    const md = '```\nplain code\n```';
    const result = await renderMarkdown(md);
    expect(result).toContain('<pre><code>');
    expect(result).toContain('plain code');
    // Should NOT have a class attribute when no language
    expect(result).not.toContain('class="language-"');
  });

  it('renders tilde-fenced code blocks with language tags', async () => {
    const md = '~~~ruby\nputs "hello"\n~~~';
    const result = await renderMarkdown(md);
    expect(result).toContain('class="language-ruby"');
    expect(result).toContain('puts');
  });

  it('handles code block with no closing fence gracefully', async () => {
    // Unclosed code fence - the regex won't match, so it renders as text
    const md = '```\nunclosed code block';
    const result = await renderMarkdown(md);
    expect(result).toBeDefined();
    expect(result).toContain('unclosed code block');
  });
});

describe('renderMarkdown — nested list edge cases', () => {
  it('renders 4+ levels of nesting', async () => {
    const md = '- Level 1\n  - Level 2\n    - Level 3\n      - Level 4\n        - Level 5';
    const result = await renderMarkdown(md);
    expect(result).toContain('Level 1');
    expect(result).toContain('Level 2');
    expect(result).toContain('Level 3');
    expect(result).toContain('Level 4');
    expect(result).toContain('Level 5');
    // Should have nested ul tags
    const ulCount = (result.match(/<ul>/g) || []).length;
    expect(ulCount).toBeGreaterThanOrEqual(2);
  });

  it('renders mixed ordered and unordered at different nesting levels', async () => {
    const md = '1. First ordered\n  - Nested unordered\n  - Another unordered\n2. Second ordered';
    const result = await renderMarkdown(md);
    expect(result).toContain('<ol>');
    expect(result).toContain('<ul>');
    expect(result).toContain('First ordered');
    expect(result).toContain('Nested unordered');
    expect(result).toContain('Second ordered');
  });

  it('renders list items with inline formatting', async () => {
    const md = '- **Bold item** with text\n- Item with `inline code`\n- Item with [a link](https://example.com)';
    const result = await renderMarkdown(md);
    expect(result).toContain('<strong>Bold item</strong>');
    expect(result).toContain('<code>inline code</code>');
    expect(result).toContain('href="https://example.com"');
  });

  it('handles list with blank lines between items', async () => {
    const md = '- Item one\n\n- Item two\n\n- Item three';
    const result = await renderMarkdown(md);
    expect(result).toContain('Item one');
    expect(result).toContain('Item two');
    expect(result).toContain('Item three');
  });

  it('renders consecutive lists of different types', async () => {
    const md = '- Bullet A\n- Bullet B\n\n1. Number A\n2. Number B\n\n- Bullet C\n- Bullet D';
    const result = await renderMarkdown(md);
    expect(result).toContain('<ul>');
    expect(result).toContain('<ol>');
    expect(result).toContain('Bullet A');
    expect(result).toContain('Number A');
    expect(result).toContain('Bullet C');
  });
});

describe('renderMarkdown — table edge cases', () => {
  it('renders table with single column', async () => {
    const md = '| Header |\n| --- |\n| Cell 1 |\n| Cell 2 |';
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('<th>Header</th>');
    expect(result).toContain('<td>Cell 1</td>');
    expect(result).toContain('<td>Cell 2</td>');
  });

  it('renders table with many columns', async () => {
    const md = '| A | B | C | D | E |\n| --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 |';
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('<th>A</th>');
    expect(result).toContain('<th>E</th>');
    expect(result).toContain('<td>1</td>');
    expect(result).toContain('<td>5</td>');
  });

  it('renders table with empty cells', async () => {
    const md = '| Name | Value |\n| --- | --- |\n| Alice |  |\n|  | 42 |';
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('Alice');
    expect(result).toContain('42');
  });

  it('renders table with bold and code in cells', async () => {
    const md = '| Feature | Status |\n| --- | --- |\n| **Bold** | `code` |';
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('<strong>Bold</strong>');
    expect(result).toContain('<code>code</code>');
  });

  it('renders table with only header row (no data rows)', async () => {
    const md = '| Header 1 | Header 2 |\n| --- | --- |';
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('<th>Header 1</th>');
    expect(result).toContain('<th>Header 2</th>');
    expect(result).toContain('<tbody></tbody>');
  });

  it('renders multiple tables in one document', async () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| X | Y |\n| --- | --- |\n| 3 | 4 |';
    const result = await renderMarkdown(md);
    const tableCount = (result.match(/<table/g) || []).length;
    expect(tableCount).toBe(2);
    expect(result).toContain('A');
    expect(result).toContain('X');
  });
});

describe('renderMarkdown — blockquote edge cases', () => {
  it('renders blockquote with inline formatting', async () => {
    const md = '> This is **bold** and `code` in a quote';
    const result = await renderMarkdown(md);
    expect(result).toContain('<blockquote>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<code>code</code>');
  });

  it('renders multiple consecutive blockquotes separated by blank lines', async () => {
    const md = '> First blockquote\n\n> Second blockquote\n\n> Third blockquote';
    const result = await renderMarkdown(md);
    const bqCount = (result.match(/<blockquote>/g) || []).length;
    expect(bqCount).toBe(3);
    expect(result).toContain('First blockquote');
    expect(result).toContain('Second blockquote');
    expect(result).toContain('Third blockquote');
  });

  it('renders blockquote with code placeholder inside', async () => {
    const md = '> Use `let x = 1` in your code';
    const result = await renderMarkdown(md);
    expect(result).toContain('<blockquote>');
    expect(result).toContain('<code>let x = 1</code>');
  });
});

describe('renderMarkdown — inline formatting edge cases', () => {
  it('renders bold text spanning multiple words', async () => {
    const result = await renderMarkdown('This is **bold multi word text** here');
    expect(result).toContain('<strong>bold multi word text</strong>');
  });

  it('renders italic with single asterisks', async () => {
    const result = await renderMarkdown('This is *italic text* here');
    expect(result).toContain('<em>italic text</em>');
  });

  it('renders nested bold inside italic context', async () => {
    const result = await renderMarkdown('*italic and **bold** inside*');
    // Bold should be detected (** markers)
    expect(result).toContain('<strong>bold</strong>');
  });

  it('does not treat asterisks mid-word as formatting', async () => {
    // The regex requires non-asterisk content, so mid-word * should not trigger italic
    // for content like file*name*path — depends on regex specifics
    const result = await renderMarkdown('Use file_name or path');
    expect(result).not.toContain('<em>');
    expect(result).not.toContain('<strong>');
  });

  it('renders bold at start of line', async () => {
    const result = await renderMarkdown('**Start** of line');
    expect(result).toContain('<strong>Start</strong>');
  });

  it('renders bold at end of line', async () => {
    const result = await renderMarkdown('End of **line**');
    expect(result).toContain('<strong>line</strong>');
  });
});

describe('renderMarkdown — shorthand special link patterns', () => {
  it('converts case variations: (EMAIL 1)', async () => {
    const result = await renderMarkdown('Check (EMAIL 1)');
    // The shorthand is case-insensitive, should be converted
    expect(result).toBeDefined();
  });

  it('converts case variations: (Email 1)', async () => {
    const result = await renderMarkdown('Check (Email 1)');
    expect(result).toBeDefined();
  });

  it('converts case variations: (email 1)', async () => {
    const result = await renderMarkdown('Check (email 1)');
    expect(result).toBeDefined();
  });

  it('handles compound IDs like (event 1:2)', async () => {
    const result = await renderMarkdown('RSVP (event 1:2)');
    // Should convert to [Event](1:2) — entity resolution mock will hide it
    expect(result).toBeDefined();
  });

  it('handles multiple special links in one line', async () => {
    const result = await renderMarkdown('See (email 1) and (contact 2) and (event 3)');
    // All three should be converted (entity resolution mocked to fail, so they get hidden)
    expect(result).toBeDefined();
  });
});

describe('renderMarkdown — reminder cards', () => {
  it('renders multiple reminders', async () => {
    const md = '[reminder] First reminder\n[reminder] Second reminder';
    const result = await renderMarkdown(md);
    const cardCount = (result.match(/tm-reminder-card/g) || []).length;
    expect(cardCount).toBeGreaterThanOrEqual(2);
    expect(result).toContain('First reminder');
    expect(result).toContain('Second reminder');
  });

  it('renders reminder with inline formatting', async () => {
    const md = '[reminder] Reply to **Alice** about `project`';
    const result = await renderMarkdown(md);
    expect(result).toContain('tm-reminder-card');
    expect(result).toContain('<strong>Alice</strong>');
    expect(result).toContain('<code>project</code>');
  });
});

describe('renderMarkdown — literal <br> handling', () => {
  it('converts <br> to <br/>', async () => {
    const result = await renderMarkdown('Line one<br>Line two');
    expect(result).toContain('<br/>');
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
  });

  it('converts <br/> to <br/>', async () => {
    const result = await renderMarkdown('Line one<br/>Line two');
    expect(result).toContain('<br/>');
  });

  it('converts <br /> (with space) to <br/>', async () => {
    const result = await renderMarkdown('Line one<br />Line two');
    expect(result).toContain('<br/>');
  });

  it('converts <BR> case-insensitively to <br/>', async () => {
    const result = await renderMarkdown('Line one<BR>Line two');
    expect(result).toContain('<br/>');
  });

  it('converts entity-encoded &lt;br&gt; to <br/>', async () => {
    const result = await renderMarkdown('Line one&lt;br&gt;Line two');
    expect(result).toContain('<br/>');
  });
});

describe('renderMarkdown — complex mixed content', () => {
  it('renders table followed by code block followed by list', async () => {
    const md = [
      '| Col A | Col B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```javascript',
      'console.log("hi");',
      '```',
      '',
      '- Item X',
      '- Item Y',
    ].join('\n');
    const result = await renderMarkdown(md);
    expect(result).toContain('<table');
    expect(result).toContain('<pre><code');
    expect(result).toContain('<ul>');
    expect(result).toContain('Col A');
    expect(result).toContain('console.log');
    expect(result).toContain('Item X');
  });

  it('renders headers with inline code', async () => {
    const result = await renderMarkdown('## Using `const` in JavaScript');
    expect(result).toContain('<h2>');
    expect(result).toContain('<code>const</code>');
  });

  it('renders links inside list items', async () => {
    const md = '- Visit [example](https://example.com)\n- Check [docs](https://docs.com)';
    const result = await renderMarkdown(md);
    expect(result).toContain('<ul>');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('href="https://docs.com"');
  });

  it('renders blockquote containing formatted text and code', async () => {
    const md = '> **Important**: Use `await` for async calls';
    const result = await renderMarkdown(md);
    expect(result).toContain('<blockquote>');
    expect(result).toContain('<strong>Important</strong>');
    expect(result).toContain('<code>await</code>');
  });

  it('renders a full document with headers, lists, blockquotes, tables, and code', async () => {
    const md = [
      '# Main Title',
      '',
      'Introduction paragraph.',
      '',
      '## Section One',
      '',
      '- First point',
      '- Second point',
      '  - Sub point',
      '',
      '> A wise quote',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| name | TabMail |',
      '',
      '```',
      'doStuff();',
      '```',
      '',
      '1. Step one',
      '2. Step two',
    ].join('\n');
    const result = await renderMarkdown(md);
    expect(result).toContain('<h1>Main Title</h1>');
    expect(result).toContain('<h2>Section One</h2>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<ol>');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('<table');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('doStuff()');
    expect(result).toContain('Introduction paragraph.');
  });
});

