import React from 'react';

const colors = ['coral', 'blue', 'green', 'violet', 'amber'] as const;

/** A stable, local identity mark for each worker, independent of its current status. */
export function AgentGlyph({ identity, running = false }: { identity: string; running?: boolean }) {
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const variant = hash % 4, color = colors[hash % colors.length];
  return <svg className={'agent-glyph agent-glyph--' + color + (running ? ' is-running' : '')} data-agent-glyph={variant + '-' + color} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    {variant === 0 ? <g stroke="currentColor" strokeWidth="1.35">{[[7.5, 7.5], [16.5, 7.5], [7.5, 16.5], [16.5, 16.5]].map(([cx, cy]) => <React.Fragment key={cx + '-' + cy}><circle cx={cx} cy={cy} r="4.6" /><circle cx={cx} cy={cy} r="2" /></React.Fragment>)}<circle className="agent-glyph-core" cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></g>
      : variant === 1 ? <g stroke="currentColor" strokeWidth="1.15">{[0, 60, 120].map((angle) => <ellipse key={angle} cx="12" cy="12" rx="4.8" ry="9.4" transform={'rotate(' + angle + ' 12 12)'} />)}<circle className="agent-glyph-core" cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></g>
        : variant === 2 ? <g fill="currentColor">{Array.from({ length: 8 }, (_, index) => <path key={index} d="M12 10.8 10.1 3.2 15.9 5.1Z" transform={'rotate(' + index * 45 + ' 12 12)'} opacity={index % 2 ? '.65' : '1'} />)}<circle className="agent-glyph-core" cx="12" cy="12" r="1.4" /></g>
          : <g stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">{[0, 90, 180, 270].map((angle) => <path key={angle} d="M12 11 7 5 12 2.5 17 5Z" transform={'rotate(' + angle + ' 12 12)'} fill="currentColor" fillOpacity=".18" />)}<circle className="agent-glyph-core" cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /></g>}
  </svg>;
}
