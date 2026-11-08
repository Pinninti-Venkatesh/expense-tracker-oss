import { useEffect, useState } from 'react';
import { canPrompt, markInstallTipSeen, onInstallChange, platform, promptInstall } from '../lib/install.js';
import { Icon } from '../components/ui.jsx';

function Step({ n, children }) {
  return (
    <div className="how-step">
      <span className="how-n" aria-hidden="true">{n}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Once per phone, after the first sync: put the app on the home screen. Uses
 * the browser's own install dialog where there is one (Chrome and Edge on
 * Android), and shows the steps where there isn't (iPhone, other browsers).
 */
export default function InstallTip({ onDone }) {
  const os = platform();
  const [promptable, setPromptable] = useState(canPrompt);

  useEffect(() => onInstallChange(() => setPromptable(canPrompt())), []);

  const finish = () => {
    markInstallTipSeen();
    onDone();
  };

  const install = async () => {
    if ((await promptInstall()) === 'accepted') finish();
  };

  return (
    <div className="solo">
      <div className="solo-card">
        <span className="solo-ico"><Icon name="download" size={26} /></span>
        <h1>Keep it on your home screen</h1>
        <p className="muted">It opens like an app, full screen, straight to this month. No app store, nothing to update.</p>

        {promptable ? (
          <button type="button" className="btn puffy wide" onClick={install}>Add to home screen</button>
        ) : (
          <div className="card">
            {os === 'ios' ? (
              <>
                <Step n={1}>Tap <b>Share</b> <Icon name="share" size={15} className="inline-ico" /> in the browser bar.</Step>
                <Step n={2}>Scroll down and tap <b>Add to Home Screen</b>.</Step>
                <Step n={3}>Tap <b>Add</b>.</Step>
              </>
            ) : (
              <>
                <Step n={1}>Open the browser menu <b aria-label="three dots">⋮</b>.</Step>
                <Step n={2}>Tap <b>Add to Home screen</b> or <b>Install app</b>.</Step>
                <Step n={3}>Confirm with <b>Add</b> or <b>Install</b>.</Step>
              </>
            )}
          </div>
        )}

        <button type="button" className="btn soft wide" onClick={finish}>{promptable ? 'Not now' : 'Done'}</button>
      </div>
    </div>
  );
}
