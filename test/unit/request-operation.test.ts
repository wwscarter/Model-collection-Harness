import { describe, expect, it } from 'vitest';
import { extractExplicitMediaConstraints, resolveRequestOperation } from '../../src/core/routing/RequestOperation';

describe('request operation shortcut', () => {
  it.each([
    '请生成一张猫咪图片',
    '帮我生图：猫咪在海边散步',
    '帮我画一只猫',
    '画一张赛博朋克海报，横版',
    '制作一张封面图',
    '生成一个科技公司 logo',
    '不要文字，生成一张夜景图片',
    '不需要视频，生成一张图片',
    'Generate an image of a mountain at sunset',
    'Please create a poster for a concert',
    'Draw a cat wearing a hat',
    'Make a photo of a blue car',
    '根据“星空下的小屋”生成一张图片',
  ])('routes a direct image request: %s', (prompt) => {
    expect(resolveRequestOperation(prompt)).toBe('image.generate');
  });

  it.each([
    '制作一段 5 秒海浪视频',
    '帮我生成视频，一只猫在走路',
    '创建一个简短的动画',
    'Create a 5 second video of waves',
    'Generate a short animation of a bird',
    'Make a video clip about winter',
  ])('routes a direct video request: %s', (prompt) => {
    expect(resolveRequestOperation(prompt)).toBe('video.generate');
  });

  it.each([
    '帮我写生图提示词',
    '帮我写视频分镜脚本',
    '生成一段用于制作图片的提示词',
    '不要生成图片，只给提示词',
    '不要生成任何图片',
    '不需要制作视频',
    'Write an image generation prompt',
    "Don't generate an image, just explain the prompt",
    'Do not create any video',
    'Write a script to make a video',
    'Explain how to generate images',
    '解释“生成一张图片”是什么意思',
    '讨论生成图片服务的实现',
    '“生成一张海报”',
    '请翻译：‘制作一个视频’',
    'The customer wrote "generate an image" in their message',
    '实现一个图片生成 API',
    '编写一个画图程序',
    '修改网页图片布局',
    '开发一个页面并生成一张背景图',
    'Build a website and generate a hero image',
    'Create a webpage and generate a background image',
    'Implement an API to generate images',
    '画一个 Mermaid 流程图',
    '生成 SVG 代码绘制图标',
    'Create SVG code to draw an icon',
    '生成一张海报和一个宣传视频',
    '设计一个海报方案',
    '聊聊今天的计划',
    '',
  ])('keeps text or compound work in the agent: %s', (prompt) => {
    expect(resolveRequestOperation(prompt)).toBe('text.chat');
  });

  it('respects explicit operation modes and rejects unknown runtime values', () => {
    expect(resolveRequestOperation('hello', 'image.generate')).toBe('image.generate');
    expect(resolveRequestOperation('generate an image', 'text.chat')).toBe('text.chat');
    expect(resolveRequestOperation('hello', 'video.generate')).toBe('video.generate');
    expect(() => resolveRequestOperation('hello', 'audio.generate' as never)).toThrow('不支持');
  });

  it('extracts explicit image and video hard constraints without inventing defaults', () => {
    expect(extractExplicitMediaConstraints('生成一张1536x864的透明背景PNG图片，比例16:9')).toEqual({ size: '1536x864', aspectRatio: '16:9', format: 'png', transparentBackground: true });
    expect(extractExplicitMediaConstraints('生成一张图片，背景不需要透明，使用webp格式')).toEqual({ format: 'webp', transparentBackground: false });
    expect(extractExplicitMediaConstraints('制作一个 5 秒的视频')).toEqual({ durationSeconds: 5 });
    expect(extractExplicitMediaConstraints('Create a 5-second video')).toEqual({ durationSeconds: 5 });
    expect(extractExplicitMediaConstraints('Make a video, 8 sec')).toEqual({ durationSeconds: 8 });
    expect(extractExplicitMediaConstraints('生成一张10:30的钟表图片')).toEqual({});
    expect(extractExplicitMediaConstraints('生成一张16:9的图片')).toEqual({ aspectRatio: '16:9' });
    expect(extractExplicitMediaConstraints('画面比例设置为16:9，生成一张图片')).toEqual({ aspectRatio: '16:9' });
    expect(extractExplicitMediaConstraints('不要透明背景，生成一张图片')).toEqual({ transparentBackground: false });
    expect(extractExplicitMediaConstraints('生成一张图片')).toEqual({});
  });

  it('rejects conflicting explicit dimensions, formats, transparency, and durations', () => {
    expect(() => extractExplicitMediaConstraints('生成一张1024x1024或1536x1024的图片')).toThrow('多个不同图片尺寸');
    expect(() => extractExplicitMediaConstraints('生成16:9或9:16比例的图片')).toThrow('多个不同画面比例');
    expect(extractExplicitMediaConstraints('生成一张透明背景但不要透明背景的图片')).toMatchObject({ transparentBackground: false });
    expect(() => extractExplicitMediaConstraints('生成png或webp格式的图片')).toThrow('冲突的图片格式');
    expect(() => extractExplicitMediaConstraints('制作5秒或10秒的视频')).toThrow('多个不同视频时长');
    expect(() => extractExplicitMediaConstraints('生成1536x864尺寸的1:1图片')).toThrow('尺寸与画面比例不一致');
  });

  it.each(['生成一张至少1920×1080的16:9图片', '生成一张不小于1920x1080的16:9图片', 'Generate an image, at least 1920x1080, 16:9', 'Generate an image, minimum size: 1920x1080, 16:9'])('preserves minimum dimensions explicitly: %s', (prompt) => {
    expect(extractExplicitMediaConstraints(prompt)).toEqual({ minSize: '1920x1080', aspectRatio: '16:9' });
  });
});
