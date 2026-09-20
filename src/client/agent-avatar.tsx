/**
 * Agent 头像：品牌红机器人，按《会话区规范》放在浅粉圆角底上。
 * 用内联 SVG 而不是位图，72px / 30px 两个尺寸都不会糊；尺寸和圆角由外层 CSS 控制。
 */
export function AgentAvatar({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 96 96"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="gea-agent-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff6f7" />
          <stop offset="1" stopColor="#ffe3e7" />
        </linearGradient>
        <linearGradient id="gea-agent-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8464f" />
          <stop offset="1" stopColor="#c8121d" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="26" fill="url(#gea-agent-tile)" />
      {/* 机器人整体略缩，30px 圆形头像裁切时不会切到天线和耳朵。 */}
      <g transform="translate(48 48) scale(0.88) translate(-48 -48)">
        <path d="M48 31V21" stroke="#d71920" strokeWidth="3.2" strokeLinecap="round" />
        <circle cx="48" cy="17.5" r="4.4" fill="#e8464f" />
        <rect x="17.5" y="47" width="7" height="15" rx="3.5" fill="#f5b3b8" />
        <rect x="71.5" y="47" width="7" height="15" rx="3.5" fill="#f5b3b8" />
        <rect x="23" y="31" width="50" height="43" rx="15" fill="url(#gea-agent-head)" />
        <rect x="33" y="41.5" width="30" height="22" rx="11" fill="#fff7f8" />
        <circle cx="42" cy="52.5" r="3.6" fill="#c8121d" />
        <circle cx="54" cy="52.5" r="3.6" fill="#c8121d" />
      </g>
    </svg>
  );
}
