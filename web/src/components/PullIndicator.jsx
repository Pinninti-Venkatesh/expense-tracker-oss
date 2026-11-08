import { PULL_THRESHOLD } from '../lib/pull.js';
import { Icon } from './ui.jsx';

/** The pill that follows a pull down from the top, then spins while refreshing. */
export default function PullIndicator({ pull, ready, refreshing }) {
  if (!pull && !refreshing) return null;
  const progress = Math.min(1, pull / PULL_THRESHOLD);

  return (
    <div
      className="pull" role="status" aria-live="polite"
      style={{ transform: `translate(-50%, ${Math.round(pull * 0.6)}px)`, opacity: refreshing ? 1 : 0.35 + progress * 0.65 }}
    >
      <span className={`pull-ico${refreshing ? ' spinning' : ''}`} style={refreshing ? undefined : { transform: `rotate(${Math.round(progress * 270)}deg)` }}>
        <Icon name="refresh" size={16} />
      </span>
      <span>{refreshing ? 'Checking your email…' : ready ? 'Release to refresh' : 'Pull to refresh'}</span>
    </div>
  );
}
