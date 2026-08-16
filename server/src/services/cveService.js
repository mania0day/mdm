import { BULLETINS, SPECIAL_CVES } from '../data/cveBulletins.js';

/**
 * Every CVE fixed in a bulletin AFTER the device's reported security patch
 * date is "unpatched" on that device. Mirrors the same logic the companion
 * mobile-security-scanner project uses (services/cve_checker/src/cve_data.py)
 * so results are consistent across both tools.
 */
function unpatchedCves(securityPatch) {
  const devicePatch = Date.parse(securityPatch);
  if (Number.isNaN(devicePatch)) {
    return { valid: false, cves: [] };
  }
  const cves = [];
  for (const [bulletinDate, list] of Object.entries(BULLETINS)) {
    if (Date.parse(bulletinDate) > devicePatch) {
      for (const cve of list) cves.push({ ...cve, bulletin: bulletinDate });
    }
  }
  for (const cve of SPECIAL_CVES) {
    if (Date.parse(cve.patch_date) > devicePatch) {
      cves.push({ ...cve, bulletin: cve.patch_date });
    }
  }
  cves.sort((a, b) => Date.parse(b.bulletin) - Date.parse(a.bulletin));
  return { valid: true, cves };
}

/**
 * Full CVE exposure summary for a device, given its Android major version
 * and security patch date. Returns null if there's no usable patch date yet
 * (device hasn't checked in with one).
 */
export function getCveExposure(osVersion, securityPatch) {
  if (!securityPatch) return null;
  const { valid, cves } = unpatchedCves(securityPatch);
  if (!valid) return null;

  // Counts are computed over the FULL unpatched list, before it's
  // truncated for display below — otherwise a fleet with >50 unpatched
  // CVEs would silently under-report its real exposure.
  const criticalCount = cves.filter((c) => c.severity === 'CRITICAL').length;
  const highCount = cves.filter((c) => c.severity === 'HIGH').length;
  const mediumCount = cves.filter((c) => c.severity === 'MEDIUM').length;

  // Android versions before 12 are out of Google's official support window.
  const majorVersion = parseInt(String(osVersion || '').split('.')[0], 10) || 0;
  const osEol = majorVersion > 0 && majorVersion < 12;
  const osEolDetails = osEol
    ? `Android ${osVersion} is end-of-life — no longer receives monthly security updates`
    : null;

  let overallLevel;
  if (osEol) overallLevel = 'CRITICAL';
  else if (criticalCount > 0) overallLevel = 'HIGH';
  else if (highCount > 0) overallLevel = 'MEDIUM';
  else if (cves.length > 0) overallLevel = 'LOW';
  else overallLevel = 'NONE';

  return {
    security_patch: securityPatch,
    os_eol: osEol,
    os_eol_details: osEolDetails,
    overall_level: overallLevel,
    vulnerable: cves.length > 0,
    total_unpatched: cves.length,
    critical_count: criticalCount,
    high_count: highCount,
    medium_count: mediumCount,
    // Capped for display (report table) — counts above are already computed
    // from the full list, so this truncation doesn't affect the numbers.
    cves: cves.slice(0, 50),
  };
}
