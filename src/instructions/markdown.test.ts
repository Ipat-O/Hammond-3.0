import { renderMarkdownToSafeHtml } from './markdown';

describe('renderMarkdownToSafeHtml', () => {
  it('renders ordinary Markdown constructs', () => {
    const html = renderMarkdownToSafeHtml(
      '# Heading\n\nBe **precise** and cite `files`.\n\n- one\n- two\n\n[docs](https://example.test/docs)',
    );

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>precise</strong>');
    expect(html).toContain('<code>files</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<a href="https://example.test/docs">docs</a>');
  });

  it('strips a raw <script> tag embedded in the Markdown source', () => {
    const html = renderMarkdownToSafeHtml('Hello <script>alert("xss")</script> world');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(');
  });

  it('strips an onerror handler from a raw <img> tag', () => {
    const html = renderMarkdownToSafeHtml('<img src="x" onerror="alert(1)">');

    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('neutralizes a javascript: link protocol', () => {
    const html = renderMarkdownToSafeHtml('[click me](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
  });

  it('neutralizes a javascript: protocol on a raw anchor tag', () => {
    const html = renderMarkdownToSafeHtml('<a href="javascript:alert(1)">click</a>');

    expect(html).not.toContain('javascript:');
  });

  it('strips inline style attributes and <style> blocks', () => {
    const html = renderMarkdownToSafeHtml(
      '<style>body{display:none}</style><p style="color:red">text</p>',
    );

    expect(html).not.toContain('<style');
    expect(html).not.toContain('style=');
    expect(html).toContain('text');
  });

  it('allows an ordinary https image', () => {
    const html = renderMarkdownToSafeHtml('![alt](https://example.test/pic.png)');

    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.test/pic.png"');
  });

  it('treats an empty string as empty output rather than throwing', () => {
    expect(renderMarkdownToSafeHtml('')).toBe('');
  });
});
