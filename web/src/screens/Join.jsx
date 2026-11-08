import { useEffect, useState } from 'react';
import { AppPasswordForm } from './SignIn.jsx';

/**
 * Opening an invite link: who sent it, then the same Gmail connection as
 * everyone else. The link works once, and only for seven days.
 */
export default function Join({ token, session }) {
  const product = session?.product || 'Expenses';
  const [invite, setInvite] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/invites/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((body) => { if (live) setInvite(body); })
      .catch(() => { if (live) setInvite({ valid: false }); });
    return () => { live = false; };
  }, [token]);

  return (
    <div className="solo welcome">
      <div className="solo-card">
        <span className="brand-mark" aria-hidden="true">₹</span>
        {!invite && <span className="loader" role="status" aria-label="Loading" />}

        {invite && !invite.valid && (
          <>
            <h1>This invite has run out</h1>
            <p className="muted">
              Invite links work once, for seven days. Ask whoever sent it for a new one. If you&apos;ve joined before, sign in instead.
            </p>
            <a className="btn puffy wide" href="/signin">Sign in</a>
          </>
        )}

        {invite?.valid && (
          <>
            <h1>{invite.from ? `${invite.from} invited you to ${product}` : `You're invited to ${product}`}</h1>
            <p className="muted">
              It reads the alerts your bank emails you and keeps your spends in one place. Others in the app can&apos;t see
              yours. They&apos;re kept on the computer running it{invite.from ? `, which ${invite.from} looks after` : ''}.
            </p>
            <AppPasswordForm extra={{ invite: token }} submitLabel="Join" />
          </>
        )}
      </div>
    </div>
  );
}
