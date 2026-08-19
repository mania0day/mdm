import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { useAuth, hasRole } from '../auth.jsx';
import { Spinner } from '../ui.jsx';

/**
 * Fallback copy of the server's POLICY_SCHEMA (server/src/services/policyEngine.js).
 * GET /policies returns the live schema and that is what the editor seeds from;
 * this is only used if an older server answers without one. Seeding matters:
 * POST/PUT store `{ ...POLICY_SCHEMA, ...body.config }`, so any key the form
 * never sends is saved as the schema default — an unchecked box that silently
 * persists as `true` would make the editor lie about what is on the device.
 * Keep in sync with the server file when the schema changes.
 */
const FALLBACK_SCHEMA = {
  min_password_length: 6,
  require_password: true,
  password_quality: 'numeric',
  max_failed_passwords: 10,
  max_screen_timeout_seconds: 300,
  disable_camera: false,
  disable_mic: false,
  require_encryption: true,
  block_rooted: true,
  force_location_on: true,
  force_airplane_mode_off: true,
  disallow_safe_boot: true,
  disallow_factory_reset: true,
  disallow_add_user: true,
  block_outgoing_calls: false,
  wifi_ssid_allowlist: [],
  block_new_app_installs: false,
  block_unknown_sources: true,
  disallow_usb_transfer: false,
  disallow_debugging: false,
  disable_screen_capture: false,
  kiosk_mode: false,
  kiosk_packages: [],
  kiosk_allow_power_menu: false,
  rule_modes: {
    disable_camera: 'enforce',
    disable_mic: 'enforce',
    block_outgoing_calls: 'enforce',
    wifi_ssid_allowlist: 'monitor',
    force_airplane_mode_off: 'enforce',
    block_new_app_installs: 'enforce',
    block_unknown_sources: 'enforce',
    disallow_usb_transfer: 'enforce',
    disallow_debugging: 'enforce',
    disable_screen_capture: 'enforce',
  },
};

/** Mirrors RULE_MODES on the server. Order is the order of the selector pills. */
const RULE_MODES = ['enforce', 'monitor', 'off'];

const MODE_LABEL = { enforce: 'Enforce', monitor: 'Monitor', off: 'Off' };

// Full literal class strings — Tailwind's JIT scans the source, so these can
// never be built by interpolating the mode name.
const MODE_PILL = {
  enforce: 'peer-checked:bg-brand-600 peer-checked:text-white',
  monitor: 'peer-checked:bg-amber-500 peer-checked:text-white',
  off: 'peer-checked:bg-slate-500 peer-checked:text-white',
};

const MODE_BADGE = {
  enforce: 'bg-brand-50 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25',
  monitor: 'bg-amber-100 text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25',
  off: 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20 dark:bg-slate-700/50 dark:text-slate-300 dark:ring-slate-500/25',
};

/**
 * Copy for the two kinds of row that have no mode selector. A mode-less rule is
 * NOT automatically an enforced one: require_encryption and block_rooted are
 * never pushed to the handset at all (nothing in the agent reads either key),
 * they are evaluated server-side in evaluateCompliance() from what the device
 * reports at check-in. Labelling those two "baseline — applied wherever the
 * device supports it" would claim an enforcement action that never happens and
 * deny the monitoring that does, so they carry their own marker.
 */
const BASELINE_MARKERS = {
  applied: {
    label: 'baseline',
    title: 'A baseline setting: it is applied wherever the device supports it, and there is nothing to monitor separately.',
  },
  compliance: {
    label: 'check only',
    title:
      'A compliance check, not a control: SENTROID cannot encrypt or un-root a handset. The device reports its state at each check-in and a breach is flagged as non-compliance — never blocked.',
  },
};

/**
 * The editable fields, grouped the way an admin thinks about them rather than
 * in schema order. A field gets an ENFORCE/MONITOR/OFF selector purely because
 * its key appears in the schema's rule_modes — nothing here declares that, so a
 * rule the server adds later cannot end up in the form without its mode.
 * `baseline` picks the marker for the rows that have no selector; it defaults
 * to 'applied' and only the detection-only rules override it.
 */
const SECTIONS = [
  {
    id: 'password',
    title: 'Password & Lock Screen',
    blurb: 'Screen-lock strength, and what happens after repeated failed unlocks.',
    fields: [
      {
        key: 'require_password',
        label: 'Require screen-lock password',
        type: 'bool',
        baseline: 'compliance',
        hint: 'Checked, not pushed — the agent never reads this key. The device reports whether a screen lock is set and one without it is marked non-compliant; what the lock must look like comes from Password quality and Min password length below.',
      },
      { key: 'password_quality', label: 'Password quality', type: 'select', options: ['none', 'numeric', 'alphanumeric', 'complex'] },
      { key: 'min_password_length', label: 'Min password length', type: 'number', min: 0 },
      {
        key: 'max_failed_passwords',
        label: 'Wipe after N failed unlocks',
        type: 'number',
        min: 0,
        hint: '0 disables the automatic wipe.',
      },
      { key: 'max_screen_timeout_seconds', label: 'Max screen timeout (s)', type: 'number', min: 0 },
    ],
  },
  {
    id: 'hardware',
    title: 'Hardware',
    blurb: 'Sensors and the dialer — the parts of the handset a policy can switch off outright.',
    fields: [
      { key: 'disable_camera', label: 'Disable camera', type: 'bool' },
      { key: 'disable_mic', label: 'Disable microphone', type: 'bool' },
      {
        key: 'block_outgoing_calls',
        label: 'Block outgoing calls',
        type: 'bool',
        hint: 'Company phone, company rules — stops personal/unbilled calls. Device Owner only; emergency numbers stay dialable.',
      },
    ],
  },
  {
    id: 'network',
    title: 'Network',
    blurb: 'Which networks the device may join, and whether it can be taken off the network on purpose.',
    fields: [
      {
        key: 'wifi_ssid_allowlist',
        label: 'Wi-Fi SSID allowlist',
        type: 'list',
        placeholder: 'e.g. CorpWiFi',
        hint:
          'The corporate networks a device may join; leave empty for unrestricted. Anything else is "free wifi" — a hotel or coffee-shop network is a classic exfiltration and MITM risk. Hard blocking needs Android 13+ (setWifiSsidPolicy); on Android 10-12 the agent can only watch and report, so Monitor is the honest choice for an older fleet.',
      },
      {
        key: 'force_airplane_mode_off',
        label: 'Block airplane mode (keep on network)',
        type: 'bool',
        hint: 'Keeps airplane mode off and stops the user switching it on. Device Owner only.',
      },
      {
        key: 'force_location_on',
        label: 'Force location always-on (block user)',
        type: 'bool',
        hint: 'Device Owner only. Live tracking is unavailable while location is off.',
      },
    ],
  },
  {
    id: 'apps',
    title: 'Apps & Data',
    blurb: 'Nothing gets installed that IT did not approve, and nothing walks out over USB, ADB or a screenshot.',
    fields: [
      {
        key: 'block_new_app_installs',
        label: 'Block new app installs',
        type: 'bool',
        hint: 'Blocks installs from every source, store included. Device Owner only.',
      },
      {
        key: 'block_unknown_sources',
        label: 'Block installs from unknown sources',
        type: 'bool',
        hint: 'Blocks sideloading from outside the store. Device Owner only.',
      },
      {
        key: 'disallow_usb_transfer',
        label: 'Block USB file transfer',
        type: 'bool',
        hint: 'Blocks MTP/mass storage; charging still works. Device Owner only.',
      },
      {
        key: 'disallow_debugging',
        label: 'Block debugging features (ADB)',
        type: 'bool',
        hint: 'Blocks ADB and Developer options. Device Owner only.',
      },
      {
        key: 'disable_screen_capture',
        label: 'Disable screen capture',
        type: 'bool',
        hint: 'Blocks screenshots and screen recording device-wide. Device Owner only.',
      },
      {
        key: 'require_encryption',
        label: 'Require storage encryption',
        type: 'bool',
        baseline: 'compliance',
        hint: 'Checked, never applied — Android gives an admin no way to encrypt a handset that is not already encrypted. A device reporting encryption off is marked non-compliant.',
      },
      {
        key: 'block_rooted',
        label: 'Flag rooted devices',
        type: 'bool',
        baseline: 'compliance',
        hint: 'Marks a device non-compliant when its check-in reports root indicators. Detection only — the agent cannot un-root a handset.',
      },
    ],
  },
  {
    id: 'availability',
    title: 'Availability',
    blurb:
      'The OS routes normally used to take a managed device off management. Android has no API to stop a hardware power-off, so these cover what can actually be enforced. Device Owner only — a plain Device Admin reports them as unapplied rather than faking success.',
    fields: [
      { key: 'disallow_safe_boot', label: 'Block safe-mode reboot', type: 'bool', hint: 'Safe Mode disables the admin, so this closes the obvious escape hatch.' },
      { key: 'disallow_factory_reset', label: 'Block factory reset', type: 'bool' },
      { key: 'disallow_add_user', label: 'Block adding users / guests', type: 'bool' },
    ],
  },
];

/** Every key the sections above render, used to catch rules the layout misses. */
const LAID_OUT_KEYS = new Set(SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

/** Same fallback chain as ruleMode() on the server: policy, then schema, then enforce. */
function normalizeMode(mode) {
  return RULE_MODES.includes(mode) ? mode : 'enforce';
}

function modeCounts(config, schema) {
  const modes = { ...(schema.rule_modes || {}), ...(config?.rule_modes || {}) };
  const counts = { enforce: 0, monitor: 0, off: 0 };
  for (const rule of Object.keys(modes)) counts[normalizeMode(modes[rule])] += 1;
  return counts;
}

function formatValue(v) {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (v === '' || v === null || v === undefined) return '—';
  return String(v);
}

function humanize(key) {
  return key.replace(/_/g, ' ');
}

/**
 * Three-way ENFORCE / MONITOR / OFF selector for one rule. Native radios keep
 * arrow-key navigation and screen-reader semantics; the visible pills are the
 * radios' siblings, styled through Tailwind's peer-checked variant.
 */
function ModeSelector({ rule, mode, onChange, disabled }) {
  return (
    <fieldset disabled={disabled} className="shrink-0">
      <legend className="sr-only">Enforcement mode for {humanize(rule)}</legend>
      <div className="inline-flex gap-0.5 rounded-md bg-slate-100 dark:bg-slate-800 p-0.5">
        {RULE_MODES.map((m) => (
          <label key={m} className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}>
            <input
              type="radio"
              name={`mode-${rule}`}
              value={m}
              checked={mode === m}
              onChange={() => onChange(m)}
              disabled={disabled}
              className="sr-only peer"
            />
            <span
              className={`block rounded px-2.5 py-1 text-xs font-semibold text-slate-500 dark:text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600/50 peer-disabled:opacity-60 ${MODE_PILL[m]}`}
            >
              {MODE_LABEL[m]}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Multi-value text input (Wi-Fi SSIDs, kiosk packages). Entries are chips, not
 * raw JSON: an admin typing a network name should never have to get bracket and
 * quote syntax right. Enter, comma or blur commits, so a value left in the box
 * when Save is clicked still makes it into the policy.
 */
function StringListInput({ id, value, onChange, disabled, placeholder }) {
  const [draft, setDraft] = useState('');
  // Dedupe and drop non-strings on the way IN, not just on the way out: config
  // is stored as z.record(z.any()) with no array validation, so a list written
  // by the API, by hand or by an older build can hold duplicates. Two chips
  // with the same value collide on the React key, and removal is by value —
  // clicking one X would drop both entries at once.
  const items = Array.isArray(value) ? [...new Set(value.filter((s) => typeof s === 'string'))] : [];

  function commit(raw) {
    const next = [...items];
    // Split on comma/newline so pasting "CorpWiFi, CorpWiFi-5G" works in one go.
    for (const entry of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (!next.includes(entry)) next.push(entry);
    }
    if (next.length !== items.length) onChange(next);
    setDraft('');
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && items.length) {
      onChange(items.slice(0, -1));
    }
  }

  return (
    <div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {items.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25 pl-2.5 pr-1.5 py-1 text-xs font-mono"
            >
              {s}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${s}`}
                  className="rounded-full p-0.5 hover:bg-brand-600/15 focus:outline-none focus:ring-2 focus:ring-brand-600/50"
                  onClick={() => onChange(items.filter((x) => x !== s))}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          className="input"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
        <button type="button" className="btn-ghost px-3" disabled={disabled || !draft.trim()} onClick={() => commit(draft)}>
          Add
        </button>
      </div>
      {!disabled && (
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Press Enter or comma to add. {items.length ? `${items.length} entr${items.length === 1 ? 'y' : 'ies'}.` : 'Empty = unrestricted.'}</p>
      )}
    </div>
  );
}

function FieldControl({ id, field, value, onChange, disabled }) {
  if (field.type === 'bool') {
    return (
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 accent-brand-600"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {field.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type="number"
      min={field.min ?? 0}
      className="input"
      value={value ?? 0}
      onChange={(e) => onChange(Number(e.target.value))}
      disabled={disabled}
    />
  );
}

function FieldRow({ field, value, onChange, mode, onModeChange, disabled }) {
  const id = `policy-${field.key}`;
  const isList = field.type === 'list';
  const marker = BASELINE_MARKERS[field.baseline] || BASELINE_MARKERS.applied;
  return (
    <div className="py-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[13rem]">
          <label htmlFor={id} className="text-sm text-slate-700 dark:text-slate-200">{field.label}</label>
          {field.hint && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 max-w-prose">{field.hint}</p>}
          {mode === 'off' && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 italic">
              Off — the value is stored but neither applied nor watched.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 ml-auto">
          {!isList && (
            <div className="w-36 flex justify-end">
              <FieldControl id={id} field={field} value={value} onChange={onChange} disabled={disabled} />
            </div>
          )}
          <div className="w-44 flex justify-end">
            {mode ? (
              <ModeSelector rule={field.key} mode={mode} onChange={onModeChange} disabled={disabled} />
            ) : (
              <span className="text-xs text-slate-400 dark:text-slate-500" title={marker.title}>
                {marker.label}
              </span>
            )}
          </div>
        </div>
      </div>
      {isList && (
        <div className="mt-2">
          <StringListInput id={id} value={value} onChange={onChange} disabled={disabled} placeholder={field.placeholder} />
        </div>
      )}
    </div>
  );
}

/**
 * Seed the form from the server schema, then layer the saved policy on top —
 * exactly the merge the API performs on save, so the controls show what will
 * actually be stored (including keys added to the schema after this policy was
 * written). rule_modes is kept out of `config` so there is one source of truth
 * for modes.
 */
function initialConfig(schema, policy) {
  const { rule_modes: _schemaModes, ...defaults } = schema;
  const { rule_modes: _savedModes, ...saved } = policy?.config || {};
  return { ...defaults, ...saved };
}

/**
 * Merge, never replace. PUT /policies/:id spreads config only one level deep,
 * so whatever rule_modes object we send REPLACES the stored one wholesale —
 * sending the merged copy is what keeps a rule the admin never touched (or one
 * this build has no field for) at its saved mode instead of silently dropping
 * back to the schema default.
 */
function initialModes(schema, policy) {
  return { ...(schema.rule_modes || {}), ...(policy?.config?.rule_modes || {}) };
}

function PolicyEditor({ policy, schema, onSave, onClose, canEdit }) {
  const [name, setName] = useState(policy?.name || '');
  const [description, setDescription] = useState(policy?.description || '');
  const [config, setConfig] = useState(() => initialConfig(schema, policy));
  const [modes, setModes] = useState(() => initialModes(schema, policy));
  const [isDefault, setIsDefault] = useState(!!policy?.is_default);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Whether we can honestly claim the write never landed — true only for a 4xx,
  // where the server rejected the request before touching anything.
  const [saveRejected, setSaveRejected] = useState(false);
  const disabled = !canEdit;
  // The fleet gets its policy from the one flagged default at enrollment
  // (routes/agent.js), so the server refuses to leave zero defaults. Moving the
  // flag is done by marking another policy default, not by clearing this one.
  const isCurrentDefault = !!policy?.is_default;

  function set(k, v) {
    setConfig((c) => ({ ...c, [k]: v }));
  }
  function setMode(rule, m) {
    setModes((prev) => ({ ...prev, [rule]: m }));
  }
  function modeFor(key) {
    // Only keys the server tracks in rule_modes get a selector; everything else
    // is a fixed row, marked by BASELINE_MARKERS[field.baseline].
    return key in modes ? normalizeMode(modes[key]) : null;
  }

  // Rules the server knows about but this build has no field for. Rare, but the
  // mode still belongs to the admin, so it gets a selector rather than being
  // quietly carried along.
  const unlaidRules = Object.keys(modes).filter((k) => !LAID_OUT_KEYS.has(k));

  /**
   * api.put/api.post throw on any non-2xx (a blank name, an expired token, a
   * dropped connection). Without this the rejection went nowhere: the modal sat
   * there looking saved while the fleet stayed on the old modes. A failed save
   * has to say so — this editor is the only surface for enforce/monitor/off.
   */
  async function submit() {
    setSaving(true);
    setError('');
    try {
      await onSave({ name, description, config: { ...config, rule_modes: modes }, is_default: isDefault });
      // No setSaving(false) on success: onSave closes the modal, so the button
      // stays disabled for the rest of this component's life on purpose.
    } catch (e) {
      setError(e.message || 'Save failed');
      // Whether the write landed is only knowable for a 4xx: the server
      // rejected the request before applying it. A 5xx, a dropped connection,
      // or an unparseable body can all happen AFTER the update committed, so
      // claiming "nothing was changed" there would be a guess presented as
      // fact — and an operator who believes it will not go and check.
      setSaveRejected(typeof e.status === 'number' && e.status >= 400 && e.status < 500);
      setSaving(false);
    }
  }

  return (
    <motion.div
      className="fixed inset-0 bg-slate-900/40 grid place-items-center z-50 p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="card w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        <div className="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="font-display font-semibold text-slate-900 dark:text-slate-100 text-lg">
            {policy ? 'Edit Policy' : 'New Policy'}
          </h2>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="policy-name">Name</label>
              <input id="policy-name" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
            </div>
            <div>
              <label className="label" htmlFor="policy-description">Description</label>
              <input id="policy-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={disabled} />
            </div>
          </div>

          {/* The whole point of the per-rule selector, stated once up front. */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">How each rule runs</p>
            <ul className="mt-2 space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
              <li className="flex gap-2">
                {/* self-start keeps the pill a pill: a stretched flex item turns
                    rounded-full into an oval next to multi-line copy. */}
                <span className={`badge shrink-0 self-start ${MODE_BADGE.enforce}`}>Enforce</span>
                <span>The device physically blocks the behaviour.</span>
              </li>
              <li className="flex gap-2">
                <span className={`badge shrink-0 self-start ${MODE_BADGE.monitor}`}>Monitor</span>
                <span>
                  The device allows it, but detects and reports every breach as a violation — visible on the device's
                  Violations tab. Use it to learn what people actually do before clamping down, and for rules an older
                  handset cannot block.
                </span>
              </li>
              <li className="flex gap-2">
                <span className={`badge shrink-0 self-start ${MODE_BADGE.off}`}>Off</span>
                <span>Neither applied nor watched.</span>
              </li>
            </ul>
            <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              Rows with no mode are fixed one way or the other: <span className="font-medium">baseline</span> rules are
              applied wherever the device supports it, while <span className="font-medium">check only</span> rules are
              never pushed to the handset — the device reports its state and a breach is flagged as non-compliance.
              Nearly every control here needs Device Owner — on a plain Device Admin the agent reports back that it
              could not apply the rule rather than claiming success.
            </p>
          </div>

          {SECTIONS.map((section) => (
            <section key={section.id}>
              <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-slate-100">{section.title}</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 max-w-prose">{section.blurb}</p>
              <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                {section.fields.map((f) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    value={config[f.key]}
                    onChange={(v) => set(f.key, v)}
                    mode={modeFor(f.key)}
                    onModeChange={(m) => setMode(f.key, m)}
                    disabled={disabled}
                  />
                ))}
              </div>
            </section>
          ))}

          {unlaidRules.length > 0 && (
            <section>
              <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-slate-100">Other Rules</h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 max-w-prose">
                Rules this dashboard has no dedicated field for yet. You can still choose how they run.
              </p>
              <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                {unlaidRules.map((rule) => (
                  <div key={rule} className="py-3 flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-slate-700 dark:text-slate-200 flex-1 min-w-[13rem]">{humanize(rule)}</span>
                    <div className="w-44 flex justify-end ml-auto">
                      <ModeSelector rule={rule} mode={normalizeMode(modes[rule])} onChange={(m) => setMode(rule, m)} disabled={disabled} />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Kiosk — deliberately fenced off from the normal rules above. */}
          <section className="rounded-lg border-2 border-dashed border-amber-300 dark:border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/5 px-4 py-4">
            <div className="flex items-center gap-2">
              <h3 className="font-display font-semibold text-sm text-amber-900 dark:text-amber-200">Kiosk / Dedicated Device</h3>
              <span className="badge bg-amber-100 text-amber-800 ring-1 ring-amber-600/25 dark:bg-amber-500/20 dark:text-amber-200 dark:ring-amber-400/30">advanced</span>
            </div>
            <p className="text-xs text-amber-800/90 dark:text-amber-200/80 mt-1.5 max-w-prose">
              Kiosk mode <strong>pins the device to the apps listed below</strong>: the launcher, every other app and
              (unless allowed) the power menu disappear. That suits a single-purpose handset — a POS terminal, scanner
              or signage tablet — and would <strong>cripple an ordinary employee phone</strong>. Leave it off unless
              that is exactly what you want. Device Owner only.
            </p>

            <div className="mt-3 divide-y divide-amber-200/70 dark:divide-amber-500/20">
              <div className="py-3 flex items-center gap-3 flex-wrap">
                <label htmlFor="policy-kiosk_mode" className="text-sm text-slate-700 dark:text-slate-200 flex-1 min-w-[13rem]">
                  Enable kiosk (lock-task) mode
                </label>
                <input
                  id="policy-kiosk_mode"
                  type="checkbox"
                  className="h-4 w-4 accent-amber-600 ml-auto"
                  checked={!!config.kiosk_mode}
                  onChange={(e) => set('kiosk_mode', e.target.checked)}
                  disabled={disabled}
                />
              </div>

              <AnimatePresence initial={false}>
                {config.kiosk_mode && (
                  <motion.div
                    key="kiosk-detail"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="divide-y divide-amber-200/70 dark:divide-amber-500/20"
                  >
                    <div className="py-3">
                      <label htmlFor="policy-kiosk_packages" className="text-sm text-slate-700 dark:text-slate-200">
                        Allowed packages
                      </label>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-prose">
                        Package names the device may run in lock-task, e.g. <span className="font-mono">com.example.pos</span>.
                        The SENTROID agent is always included so the device stays manageable. An empty list pins the
                        device to the agent alone.
                      </p>
                      <div className="mt-2">
                        <StringListInput
                          id="policy-kiosk_packages"
                          value={config.kiosk_packages}
                          onChange={(v) => set('kiosk_packages', v)}
                          disabled={disabled}
                          placeholder="e.g. com.example.pos"
                        />
                      </div>
                    </div>
                    <div className="py-3 flex items-start gap-3 flex-wrap">
                      <div className="flex-1 min-w-[13rem]">
                        <label htmlFor="policy-kiosk_allow_power_menu" className="text-sm text-slate-700 dark:text-slate-200">
                          Allow the power menu
                        </label>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-prose">
                          Off suppresses the power/global-actions dialog — the only supported way to hide it. A long
                          press still forces a firmware-level shutdown, so this reduces casual power-offs rather than
                          preventing them.
                        </p>
                      </div>
                      <input
                        id="policy-kiosk_allow_power_menu"
                        type="checkbox"
                        className="h-4 w-4 accent-amber-600 ml-auto"
                        checked={!!config.kiosk_allow_power_menu}
                        onChange={(e) => set('kiosk_allow_power_menu', e.target.checked)}
                        disabled={disabled}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>

          <div>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                disabled={disabled || isCurrentDefault}
              />
              Set as default policy for new devices
            </label>
            {isCurrentDefault && (
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-prose">
                This is the current default. It cannot simply be cleared — a device that enrols without an explicit
                assignment gets the default policy, so the fleet always needs one. Mark another policy as default to
                move the flag.
              </p>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800">
          {error && (
            <div className="text-sm text-red-500 dark:text-red-400 mb-2">
              Not saved — {error}.{' '}
              {saveRejected
                ? 'Nothing on the server was changed.'
                : 'The server may or may not have applied this — reload and check before retrying.'}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>Close</button>
            {canEdit && (
              <button className="btn-primary" onClick={submit} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function Policies() {
  const { user } = useAuth();
  const canEdit = hasRole(user, 'admin');
  const [policies, setPolicies] = useState(null);
  const [schema, setSchema] = useState(FALLBACK_SCHEMA);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = () =>
    api
      .get('/policies')
      .then((d) => {
        setPolicies(d.policies);
        setError('');
        // The server ships its POLICY_SCHEMA with the list; prefer it over the
        // local copy so a schema change on the server shows up here without a
        // dashboard rebuild.
        if (d.schema) setSchema(d.schema);
      })
      // A failed GET used to leave the page on a permanent spinner, which reads
      // as "still loading" forever. Say the request failed instead.
      .catch((e) => setError(e.message || 'Could not load policies'));
  useEffect(() => { load(); }, []);

  // Deliberately does not catch: the rejection is what PolicyEditor shows in
  // its footer. Swallowing it here would close the modal on a write that never
  // reached the server.
  async function save(body) {
    if (editing?.id) await api.put(`/policies/${editing.id}`, body);
    else await api.post('/policies', body);
    setEditing(null);
    load();
  }

  async function remove(p) {
    if (!confirm(`Delete policy "${p.name}"?`)) return;
    try {
      await api.del(`/policies/${p.id}`);
      load();
    } catch (e) {
      // e.g. the server's guard on deleting the default policy.
      setError(e.message || 'Could not delete the policy');
    }
  }

  if (!policies) {
    return error ? (
      <div className="card p-5">
        <h1 className="font-display font-semibold text-slate-900 dark:text-slate-100">Security Policies</h1>
        <p className="text-sm text-red-500 dark:text-red-400 mt-1">Could not load policies — {error}.</p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-prose">
          The request failed; this is not a claim that no policies exist. What the devices are running cannot be read
          from here until it succeeds.
        </p>
        <button className="btn-ghost mt-3" onClick={load}>Retry</button>
      </div>
    ) : (
      <Spinner />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">Security Policies</h1>
          <p className="text-sm text-slate-400 dark:text-slate-500">
            Rule-based enforcement pushed to managed devices — each rule blocks, watches, or stands down
          </p>
        </div>
        {canEdit && (
          <button className="btn-primary" onClick={() => setEditing({})}>+ New Policy</button>
        )}
      </div>

      {error && <div className="card p-3 text-sm text-red-500 dark:text-red-400">{error}</div>}

      <motion.div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        variants={listVariants}
        initial="hidden"
        animate="show"
      >
        {policies.map((p) => {
          const counts = modeCounts(p.config, schema);
          return (
            <motion.div
              key={p.id}
              className="card card-hover p-5"
              variants={itemVariants}

              transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-display font-semibold text-slate-900 dark:text-slate-100">{p.name}</h3>
                    {p.is_default ? <span className="badge bg-brand-50 text-brand-700 ring-1 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/25">default</span> : null}
                    {p.config?.kiosk_mode ? <span className="badge bg-amber-100 text-amber-800 ring-1 ring-amber-600/25 dark:bg-amber-500/20 dark:text-amber-200 dark:ring-amber-400/30">kiosk</span> : null}
                  </div>
                  <p className="text-sm text-slate-400 dark:text-slate-500 mt-0.5">{p.description}</p>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">{p.device_count} device(s)</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {RULE_MODES.map((m) => (
                  <span key={m} className={`badge ${MODE_BADGE[m]}`}>
                    {counts[m]} {m === 'enforce' ? 'enforced' : m === 'monitor' ? 'monitored' : 'off'}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-4 text-xs">
                {Object.entries(p.config)
                  // rule_modes is summarised by the badges above; dumping the
                  // object here would just print [object Object].
                  .filter(([k]) => k !== 'rule_modes')
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-slate-500 dark:text-slate-400">{humanize(k)}</span>
                      <span className="text-slate-700 dark:text-slate-200 font-mono truncate" title={formatValue(v)}>{formatValue(v)}</span>
                    </div>
                  ))}
              </div>
              <div className="flex gap-2 mt-4">
                <button className="btn-ghost text-xs" onClick={() => setEditing(p)}>
                  {canEdit ? 'Edit' : 'View'}
                </button>
                {canEdit && !p.is_default && (
                  <button className="btn-ghost text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300" onClick={() => remove(p)}>Delete</button>
                )}
              </div>
            </motion.div>
          );
        })}
      </motion.div>

      <AnimatePresence>
        {editing && (
          <PolicyEditor
            // Remount per policy so the form state is seeded from whichever
            // policy was opened, never carried over from the last one.
            key={editing.id || 'new'}
            policy={editing.id ? editing : null}
            schema={schema}
            canEdit={canEdit}
            onSave={save}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
