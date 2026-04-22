/**
 * @fileoverview Profile — name, avatar, and practice targets.
 *
 * Targets are resolved in this priority order:
 *   1. weeklyTargetOverrides[currentWeekKey]   (user set a specific target this week)
 *   2. profile.targets                         (the default baseline)
 *   3. PROFILE_DEFAULTS.targets                (hard-coded fallback)
 *
 * @module profile
 */

import { STORAGE_KEYS, PROFILE_DEFAULTS } from './config.js';
import practiceTracker from './practice-tracker.js';

function _load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
        const saved = raw ? JSON.parse(raw) : {};
        return {
            name: saved.name ?? PROFILE_DEFAULTS.name,
            createdAt: saved.createdAt ?? null,
            avatar: saved.avatar ?? PROFILE_DEFAULTS.avatar,
            targets: { ...PROFILE_DEFAULTS.targets, ...(saved.targets || {}) },
            weeklyTargetOverrides: { ...(saved.weeklyTargetOverrides || {}) },
        };
    } catch {
        return {
            name: PROFILE_DEFAULTS.name,
            createdAt: null,
            avatar: PROFILE_DEFAULTS.avatar,
            targets: { ...PROFILE_DEFAULTS.targets },
            weeklyTargetOverrides: {},
        };
    }
}

function _save(profile) {
    try {
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
    } catch (e) {
        console.warn('[profile] Save failed:', e);
    }
}

/**
 * Returns the current profile, ensuring `createdAt` is populated on first
 * read (so "Practicing since …" always has a value).
 */
function getProfile() {
    const p = _load();
    if (!p.createdAt) {
        p.createdAt = new Date().toISOString();
        _save(p);
    }
    return p;
}

function setName(name) {
    const p = getProfile();
    p.name = String(name || '').trim() || PROFILE_DEFAULTS.name;
    _save(p);
    return p;
}

function setAvatar(avatar) {
    const p = getProfile();
    p.avatar = avatar || null;
    _save(p);
    return p;
}

/**
 * Overwrite the baseline (profile-level) targets.
 * @param {{dailyMinutes?: number, weeklyHours?: number}} partial
 */
function setTargets(partial) {
    const p = getProfile();
    p.targets = { ...p.targets, ...(partial || {}) };
    _save(p);
    return p;
}

/**
 * Set or clear an override for a specific week (YYYY-Www). Pass null to
 * clear. Passing `'current'` as weekKey uses this week's ISO key.
 */
function setWeeklyTarget(weekKey, partial) {
    const p = getProfile();
    const key = weekKey === 'current' ? practiceTracker._weekKey() : weekKey;
    if (partial == null) {
        delete p.weeklyTargetOverrides[key];
    } else {
        p.weeklyTargetOverrides[key] = { ...(p.weeklyTargetOverrides[key] || {}), ...partial };
    }
    _save(p);
    return p;
}

/**
 * Resolve the effective target for a given ISO week (defaults to current).
 */
function getTargetFor(weekKey) {
    const p = getProfile();
    const key = weekKey || practiceTracker._weekKey();
    const override = p.weeklyTargetOverrides[key] || {};
    return { ...p.targets, ...override };
}

/** Remove the entire profile (used by Reset). */
function reset() {
    localStorage.removeItem(STORAGE_KEYS.PROFILE);
}

const profile = {
    getProfile,
    setName,
    setAvatar,
    setTargets,
    setWeeklyTarget,
    getTargetFor,
    reset,
};

export default profile;
