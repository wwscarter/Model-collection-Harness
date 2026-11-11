import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OutputView } from '../../src/renderer/components/OutputView';

const render = (content: string, loading = false) => renderToStaticMarkup(createElement(OutputView, { content, loading, emptyState: false }));

describe('response output rendering', () => {
  it('keeps received HTML as visible source text', () => {
    const markup = render('<main>正文</main>');
    expect(markup).toContain('&lt;main&gt;正文&lt;/main&gt;');
    expect(markup).not.toContain('<main>正文</main>');
  });

  it('shows a partially streamed code block with its language and generation state', () => {
    const fence = String.fromCharCode(96).repeat(3);
    const markup = render(fence + 'ts\nconst ready = true;', true);
    expect(markup).toContain('TypeScript');
    expect(markup).toContain('生成中');
    expect(markup).toContain('token keyword');
    expect(markup).toContain('code-line-numbers');
  });

  it('preserves headings, inline code, and ordered response steps', () => {
    const markup = render('# 操作步骤\n\n1. 运行 `npm install`\n2. 点击 **开始**');
    expect(markup).toContain('<h3>操作步骤</h3>');
    expect(markup).toContain('<ol start="1">');
    expect(markup).toContain('<code>npm install</code>');
    expect(markup).toContain('<strong>开始</strong>');
  });

  it('renders a saved image without requiring a text answer or exposing file paths', () => {
    const markup = renderToStaticMarkup(createElement(OutputView, { content: '', loading: false, emptyState: false, artifacts: [{ id: 'asset-1', kind: 'image', mimeType: 'image/png', fileName: 'generated.png', modelId: 'image-model', configurationId: 'image-config', jobId: 'job-1', width: 1024, height: 1024 }] }));
    expect(markup).toContain('newai-media://asset/asset-1');
    expect(markup).toContain('image-model');
    expect(markup).toContain('另存为');
    expect(markup).not.toContain('输出会显示在这里');
  });

  it('shows the generating job while no image has arrived', () => {
    const markup = renderToStaticMarkup(createElement(OutputView, { content: '', loading: true, emptyState: false, mediaJobs: [{ id: 'job-1', operation: 'image.generate', status: 'running', modelId: 'image-model' }] }));
    expect(markup).toContain('图片 · 正在生成');
    expect(markup).not.toContain('正在规划并执行任务');
  });
});
