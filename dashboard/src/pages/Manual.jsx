import { motion } from 'framer-motion';

// Steps are a real ordered sequence, so they're numbered.
const STEPS = [
  {
    t: 'Factory reset the phone',
    s: 'Settings → General management → Reset → Factory data reset. Back up first — this wipes the device. A reset is required: an existing Google/Samsung/Knox account blocks Device Owner.',
  },
  {
    t: 'On the "Hi there / Welcome" setup screen, tap the screen 6 times',
    s: 'This opens the QR reader used for enterprise provisioning. Do not add a Google or Samsung account.',
  },
  {
    t: 'Connect to Wi-Fi that can reach the server',
    s: "The phone must be on the same network as the SENTROID server so it can download the app. On a hotspot demo, that's the network the server runs on.",
  },
  {
    t: 'Scan the provisioning QR',
    s: 'The phone downloads SENTROID, verifies the signing checksum, sets it as Device Owner, and auto-enrolls with the baked-in token — no manual entry.',
  },
  {
    t: 'Done',
    s: 'The device shows "Device Owner (full control)" and every "owner only" policy flips to enforced on the next check-in.',
  },
];

const ENFORCED = [
  'Location forced on and locked — the user can’t disable it',
  'Airplane mode blocked — the device can’t go off-network',
  'Permissions auto-granted and locked — the user can’t revoke them',
  'Full IMEI read for inventory',
  'Status-bar / kiosk lockdown on Disable',
  'Password reset and the full password policy enforced',
];

const section = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' } } };

function Check() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 mt-0.5 shrink-0 text-accent-600 dark:text-accent-400" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function Manual() {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">Manual</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Setup &amp; operations reference for the SENTROID console.</p>
      </div>

      <motion.section variants={section} initial="hidden" animate="show" className="card p-5 space-y-4">
        <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Promote a phone to Device Owner</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Location-always-on, airplane-mode block, and permission-locking are <strong>Device Owner</strong>-only Android
          controls. They’re already in the policy and enforce automatically the moment the app becomes Device Owner —
          this is how you get there.
        </p>

        {/* Caution banner */}
        <div className="flex gap-3 items-start rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
          <svg className="h-5 w-5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p className="text-sm text-amber-800 dark:text-amber-200">
            <strong>A factory reset is required.</strong> A phone already signed into a Google account — and Samsung’s
            hidden Samsung/Knox accounts — makes <code className="font-mono text-xs">dpm set-device-owner</code> fail with
            “already some accounts.” Device Owner can only be set on a freshly-reset device with no accounts.
          </p>
        </div>

        <ol className="space-y-2.5">
          {STEPS.map((st, i) => (
            <li key={i} className="flex gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-3">
              <span className="grid place-items-center h-7 w-7 shrink-0 rounded-md bg-brand-600 text-white text-sm font-bold">{i + 1}</span>
              <div>
                <div className="font-medium text-slate-800 dark:text-slate-100">{st.t}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{st.s}</div>
              </div>
            </li>
          ))}
        </ol>
      </motion.section>

      <motion.section variants={section} initial="hidden" animate="show" className="card p-5">
        <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 mb-3">What turns on once it’s Device Owner</h2>
        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
          {ENFORCED.map((e) => (
            <li key={e} className="flex gap-2 text-sm text-slate-700 dark:text-slate-200"><Check />{e}</li>
          ))}
        </ul>
      </motion.section>

      <motion.section variants={section} initial="hidden" animate="show" className="card p-5 space-y-3">
        <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100">Generate / regenerate the QR</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The QR bakes in this machine’s server IP and a fresh single-use token — both change when you switch Wi-Fi /
          hotspot. With the server running, regenerate everything (checksum, current IP, new token) in one command:
        </p>
        <pre className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg p-3 overflow-x-auto text-xs font-mono text-slate-700 dark:text-slate-200">cd android-agent &amp;&amp; ./make-do-qr.sh</pre>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Then open <code className="font-mono text-xs">android-agent/do-provisioning.svg</code> and scan it during the phone’s setup wizard.
        </p>

        <h3 className="font-semibold text-slate-800 dark:text-slate-100 pt-1">Prefer ADB?</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          It still needs the factory reset, and unlike the QR it does <strong>not</strong> auto-enroll (enter a token in
          the app afterward). After resetting, skipping all accounts, and enabling USB debugging:
        </p>
        <pre className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg p-3 overflow-x-auto text-xs font-mono text-slate-700 dark:text-slate-200">adb shell dpm set-device-owner \
  com.sentroid.agent/.admin.SentroidDeviceAdminReceiver</pre>
      </motion.section>
    </div>
  );
}
