import { describe, expect, it } from 'vitest';
import { resolveRequestOperation } from '../../src/core/routing/RequestOperation';

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
});
