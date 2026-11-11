import type { ModelOperation } from '@core/models/ModelOperations';

export type RequestOperationMode = 'auto' | ModelOperation;
const MODES: readonly string[] = ['auto', 'text.chat', 'image.generate', 'video.generate'];

/** Direct media is a shortcut for one clear deliverable; compound tasks retain their agent. */
export function resolveRequestOperation(prompt: string, explicit: RequestOperationMode = 'auto'): ModelOperation {
  if (!MODES.includes(explicit)) throw new Error('不支持的请求操作类型');
  if (explicit !== 'auto') return explicit;
  const text = prompt.toLocaleLowerCase().trim();
  if (!text) return 'text.chat';
  // Quoted instructions are data; generation intent must also exist outside quotations.
  const intent = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|`[^`]*`/gs, ' ');
  if (isTextWork(intent)) return 'text.chat';
  const image = !negated(intent, 'image') && imageIntent(intent);
  const video = !negated(intent, 'video') && videoIntent(intent);
  if (image && video) return 'text.chat';
  if (image) return 'image.generate';
  if (video) return 'video.generate';
  return 'text.chat';
}

function isTextWork(text: string): boolean {
  const textDeliverable = /(?:写|编写|提供|给我|生成|整理|优化|润色|翻译|解释|分析|讨论|比较|介绍|总结|设计|制定).{0,30}(?:提示词|prompt|分镜|脚本|文案|教程|说明|需求文档|方案|步骤|代码|程序|接口|函数|组件|api\b)|(?:提示词|prompt|分镜|脚本|文案|教程|方案|代码|程序|接口).{0,15}(?:怎么写|如何写|是什么|是什么意思|的区别)/s;
  const englishText = /\b(?:write|explain|discuss|analy[sz]e|compare|translate|improve|rewrite|summari[sz]e)\b.{0,70}\b(?:prompts?|scripts?|storyboards?|code|api|function|program|tutorial|instructions?|requirements?|plan)\b/s;
  const codeWork = /(?:开发|实现|搭建|编写|修改|修复|重构|调试).{0,70}(?:网站|网页|页面|应用|接口|程序|组件|代码|api\b|功能)|(?:创建|制作).{0,30}(?:网站|网页|页面|应用|组件)(?!设计图|效果图)|\b(?:build|develop|implement|debug|refactor|fix|modify|create|make)\b.{0,80}\b(?:website|webpage|web page|page|app|application|component|api|code|program|feature)\b/s;
  const codeDiagram = /\b(?:mermaid|plantuml)\b|(?:svg|html|css).{0,15}(?:代码|源码)|(?:代码|源码).{0,15}(?:svg|html|css)|\b(?:svg|html|css)\s+(?:code|source)\b/;
  const discussion = /^(?:请|帮我|能否|可以|麻烦|想知道|我想了解|我想问|一下|\s)*(?:解释|分析|讨论|比较|介绍|总结|评估|研究|如何|怎么|为什么|是否|什么是)|^(?:please\s+)?(?:explain|discuss|compare|analy[sz]e|what\s+(?:is|does)|how\s+(?:to|do|does|can)|why\s+|whether\s+)/s;
  return textDeliverable.test(text) || englishText.test(text) || codeWork.test(text) || codeDiagram.test(text) || discussion.test(text);
}

function imageIntent(text: string): boolean {
  return /^(?:(?:请|帮我|我要|我想|给我|需要|麻烦|直接|先|马上|开始)\s*)*生图(?:[:：，,\s]|$)|(?:生成|制作|创建|绘制|画|生).{0,24}(?:图片|图像|照片|插画|海报|封面|壁纸|背景图|头像|图标|配图|效果图|设计图|logo\b)|(?:生成|绘制|画)(?:一|两|几|\d+)?(?:张|幅|只).{0,40}|\b(?:generate|create|make|render|draw|paint)\b.{0,50}\b(?:image|picture|photo|illustration|poster|wallpaper|cover|avatar|icon|logo)\b|^\s*(?:please\s+)?(?:draw|paint)\s+(?:me\s+)?(?:an?\s+|the\s+)/s.test(text);
}

function videoIntent(text: string): boolean {
  return /(?:生成|制作|创建|做|拍).{0,30}(?:视频|短片|影片|动画)|\b(?:generate|create|make|render|produce)\b.{0,60}\b(?:video|clip|movie|animation)\b/s.test(text);
}

function negated(text: string, kind: 'image' | 'video'): boolean {
  const noun = kind === 'image' ? '(?:图(?:片|像)?|照片|海报|image|picture|photo|poster)' : '(?:视频|短片|动画|video|clip|animation)';
  return new RegExp('(?:不要|不需要|无需|别|不必|禁止)[^，。；,;\n]{0,12}' + noun + '|(?:do\\s+not|don[’\x27]t|no|without)\\s+(?:(?:generate|create|make|draw|any)\\s+){0,3}' + noun, 'i').test(text);
}
