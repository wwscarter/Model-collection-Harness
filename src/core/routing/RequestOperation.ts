import type { ModelOperation } from '@core/models/ModelOperations';

export type RequestOperationMode = 'auto' | ModelOperation;
export interface ExplicitMediaConstraints {
  size?: string;
  aspectRatio?: string;
  format?: 'png' | 'jpeg' | 'webp';
  transparentBackground?: boolean;
  durationSeconds?: number;
}
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

/** Extract only explicit media parameters; absent preferences remain unset. */
export function extractExplicitMediaConstraints(prompt: string): ExplicitMediaConstraints {
  const text = prompt.toLocaleLowerCase();
  const constraints: ExplicitMediaConstraints = {};
  const sizes = new Set([...text.matchAll(/(?<![\d:])([1-9]\d{1,4})\s*[x×]\s*([1-9]\d{1,4})(?!\d)/g)]
    .map((match) => Number(match[1]) + 'x' + Number(match[2])));
  if (sizes.size > 1) throw new Error('请求中包含多个不同图片尺寸，请只指定一个尺寸');
  if (sizes.size === 1) constraints.size = [...sizes][0];

  const ratioTokens = [...text.matchAll(/(?<!\d)(\d{1,3})\s*:\s*(\d{1,3})(?!\d)/g)];
  const knownRatios = new Set(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21']);
  const ratios = new Set(ratioTokens.filter((match) => knownRatios.has(Number(match[1]) + ':' + Number(match[2]))
    || /(?:比例|画幅|宽高比|aspect\s*ratio|ratio)[^，。；,;\n]{0,12}$/i.test(text.slice(Math.max(0, match.index! - 28), match.index))
    || /^(?:比例|画幅|宽高比|aspect\s*ratio|ratio)[^，。；,;\n]{0,12}/i.test(text.slice(match.index! + match[0].length, match.index! + match[0].length + 16)))
    .map((match) => Number(match[1]) + ':' + Number(match[2])));
  if (ratios.size > 1) throw new Error('请求中包含多个不同画面比例，请只指定一个比例');
  if (ratios.size === 1) constraints.aspectRatio = [...ratios][0];
  if (constraints.size && constraints.aspectRatio) {
    const [width, height] = constraints.size.split('x').map(Number);
    const [ratioWidth, ratioHeight] = constraints.aspectRatio.split(':').map(Number);
    if (Math.abs(width / height - ratioWidth / ratioHeight) >= 0.01) throw new Error('图片尺寸与画面比例不一致，请确认后重试');
  }

  const formats = new Set<'png' | 'jpeg' | 'webp'>([
    ...(/\bpng\b|png\s*格式|格式\s*png/.test(text) ? ['png' as const] : []),
    ...(/\b(?:jpeg|jpg)\b|jpeg\s*格式|jpg\s*格式/.test(text) ? ['jpeg' as const] : []),
    ...(/\bwebp\b|webp\s*格式/.test(text) ? ['webp' as const] : []),
  ]);
  if (formats.size > 1) throw new Error('请求中包含冲突的图片格式');
  if (formats.size === 1) constraints.format = [...formats][0];

  const asksTransparent = /透明(?:背景|底)|背景透明|transparent\s+background|transparent\s+bg/.test(text);
  const deniesTransparent = /(?:不要|不需要|无需|别|不必)[^，。；,;\n]{0,12}(?:透明(?:背景|底)|背景透明)|(?:透明(?:背景|底)|背景透明)[^，。；,;\n]{0,12}(?:不要|不需要|无需|别|不必)|(?:背景|底色)[^，。；,;\n]{0,6}(?:不要|不需要|无需|别|不必)[^，。；,;\n]{0,6}透明|(?:背景|底色|background)\s*(?:不透明|opaque)|(?:opaque\s+background|solid\s+background)/.test(text);
  const activeTransparent = asksTransparent && !deniesTransparent;
  if (activeTransparent) constraints.transparentBackground = true;
  else if (deniesTransparent) constraints.transparentBackground = false;

  const durations = new Set([...text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?:\s*[-–]\s*|\s*)(?:秒钟|秒|seconds?|secs?)(?!\w)/g)].map((match) => Number(match[1])));
  const shortDurations = [...text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*s\b/g)].map((match) => Number(match[1]));
  for (const seconds of shortDurations) durations.add(seconds);
  if (durations.size > 1) throw new Error('请求中包含多个不同视频时长，请只指定一个时长');
  if (durations.size === 1) constraints.durationSeconds = [...durations][0];
  return constraints;
}
