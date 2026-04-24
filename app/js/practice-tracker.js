/**
 * @fileoverview Practice tracker — records app usage and exercise minutes.
 *
 * Core concepts:
 *  - **App time**: seconds the app is foreground AND the user interacted
 *    within the last 5 minutes. Idle beyond that is not counted.
 *  - **Exercise time**: seconds an exercise was actively playing
 *    (Start→Stop/Pause).
 *
 * Storage layout (under STORAGE_KEYS.ACTIVITY):
 * ```
 * {
 *   daily:   { "YYYY-MM-DD": { appSec, exerciseSec } },     // last 30 days
 *   weekly:  { "YYYY-Www":   { appSec, exerciseSec, days } },// last 26 weeks
 *   monthly: { "YYYY-MM":    { appSec, exerciseSec, days } },// forever
 *   streak:  { current, longest, lastActiveDate }
 * }
 * ```
 *
 * On every app open, older entries are rolled up:
 * `daily` older than 30d → weekly; `weekly` older than 26w → monthly.
 *
 * All times stored in **seconds** to avoid decimal arithmetic drift. The
 * UI converts to minutes for display.
 *
 * @module practice-tracker
 */

import { STORAGE_KEYS } from './config.js';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_MS = 30 * 1000;        // 30 seconds
const DAILY_WINDOW_DAYS = 30;
const WEEKLY_WINDOW_DAYS = 26 * 7;     // 26 weeks

// ------------------------------------------------------------------
// Date helpers
// ------------------------------------------------------------------

function todayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function monthKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * ISO-8601 week label (YYYY-Www). Week 1 contains Jan 4 (ISO rule).
 */
function weekKey(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function parseDateKey(key) {
    // "YYYY-MM-DD" → Date at local midnight.
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
    return Math.floor((b - a) / 86400000);
}

// ------------------------------------------------------------------
// Storage
// ------------------------------------------------------------------

function _emptyActivity() {
    return {
        daily: {},
        weekly: {},
        monthly: {},
        streak: { current: 0, longest: 0, lastActiveDate: null },
    };
}

function _load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.ACTIVITY);
        if (!raw) return _emptyActivity();
        const parsed = JSON.parse(raw);
        // Fill any missing top-level keys.
        return {
            daily: parsed.daily || {},
            weekly: parsed.weekly || {},
            monthly: parsed.monthly || {},
            streak: parsed.streak || { current: 0, longest: 0, lastActiveDate: null },
        };
    } catch {
        return _emptyActivity();
    }
}

function _save(activity) {
    try {
        localStorage.setItem(STORAGE_KEYS.ACTIVITY, JSON.stringify(activity));
    } catch (e) {
        console.warn('[practice-tracker] Save failed:', e);
    }
}

// ------------------------------------------------------------------
// Rollup
// ------------------------------------------------------------------

/**
 * Merge daily entries older than 30 days into weekly; merge weekly
 * entries older than 26 weeks into monthly. Idempotent.
 */
function _rollup(activity) {
    const now = new Date();
    let changed = false;

    for (const [dateKey, entry] of Object.entries(activity.daily)) {
        const d = parseDateKey(dateKey);
        if (isNaN(d.getTime())) continue;
        if (daysBetween(d, now) <= DAILY_WINDOW_DAYS) continue;

        const wk = weekKey(d);
        const bucket = activity.weekly[wk] || { appSec: 0, exerciseSec: 0, days: 0 };
        bucket.appSec += entry.appSec || 0;
        bucket.exerciseSec += entry.exerciseSec || 0;
        bucket.days = (bucket.days || 0) + 1;
        activity.weekly[wk] = bucket;
        delete activity.daily[dateKey];
        changed = true;
    }

    for (const [wk, entry] of Object.entries(activity.weekly)) {
        // Derive a date from the week key to compute age.
        const m = /^(\d{4})-W(\d{2})$/.exec(wk);
        if (!m) continue;
        const yr = Number(m[1]);
        const wnum = Number(m[2]);
        // Approx: Thursday of ISO week
        const jan4 = new Date(Date.UTC(yr, 0, 4));
        const thu = new Date(jan4);
        thu.setUTCDate(jan4.getUTCDate() + (wnum - 1) * 7 - ((jan4.getUTCDay() + 6) % 7) + 3);

        if (daysBetween(thu, now) <= WEEKLY_WINDOW_DAYS) continue;

        const mk = monthKey(thu);
        const bucket = activity.monthly[mk] || { appSec: 0, exerciseSec: 0, days: 0 };
        bucket.appSec += entry.appSec || 0;
        bucket.exerciseSec += entry.exerciseSec || 0;
        bucket.days = (bucket.days || 0) + (entry.days || 0);
        activity.monthly[mk] = bucket;
        delete activity.weekly[wk];
        changed = true;
    }

    return changed;
}

// ------------------------------------------------------------------
// Streak
// ------------------------------------------------------------------

function _bumpStreak(activity) {
    const today = todayKey();
    const s = activity.streak;
    if (s.lastActiveDate === today) return; // already counted

    if (s.lastActiveDate) {
        const last = parseDateKey(s.lastActiveDate);
        const gap = daysBetween(last, new Date());
        if (gap === 1) {
            s.current = (s.current || 0) + 1;
        } else if (gap > 1) {
            s.current = 1;
        } else {
            // Same day or future date; leave as-is.
        }
    } else {
        s.current = 1;
    }
    s.longest = Math.max(s.longest || 0, s.current);
    s.lastActiveDate = today;
}

// ------------------------------------------------------------------
// Session state (module-scoped)
// ------------------------------------------------------------------

let _lastInteraction = Date.now();
let _heartbeatTimer = null;
let _lastBeatAt = null;
let _appSessionActive = false;

let _exerciseActive = false;
let _exerciseStartAt = null;

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Start the activity clock. Should be called from app.js once after
 * settings load. Safe to call multiple times (idempotent).
 */
function startAppSession() {
    const activity = _load();
    if (_rollup(activity)) _save(activity);

    _lastInteraction = Date.now();
    _lastBeatAt = Date.now();
    _appSessionActive = true;

    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_MS);
}

/**
 * Flush the in-flight heartbeat and stop the clock. Call on
 * beforeunload / visibilitychange:hidden.
 */
function endAppSession() {
    _heartbeat(); // final app-time flush
    // If an exercise was running, flush its partial time and pause it.
    if (_exerciseActive) {
        const now = Date.now();
        const elapsedSec = Math.max(0, Math.round((now - _exerciseStartAt) / 1000));
        if (elapsedSec > 0) _recordExercise(elapsedSec);
        _exerciseActive = false;
        _exerciseStartAt = null;
    }
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    _appSessionActive = false;
}

/**
 * Note that the user just interacted (tap / key / scroll). Extends the
 * idle window so heartbeats continue to count.
 */
function noteActivity() {
    _lastInteraction = Date.now();
}

/** Begin tracking exercise time. Idempotent; repeat calls are no-ops. */
function startExercise(exerciseId = null) {
    if (_exerciseActive) return;
    _exerciseActive = true;
    _exerciseStartAt = Date.now();
    noteActivity();
}

/** End exercise tracking; flushes accumulated seconds to today's bucket. */
function endExercise() {
    if (!_exerciseActive) return;
    const now = Date.now();
    const elapsedSec = Math.max(0, Math.round((now - _exerciseStartAt) / 1000));
    _exerciseActive = false;
    _exerciseStartAt = null;
    if (elapsedSec > 0) _recordExercise(elapsedSec);
}

/** Pause = end; a subsequent Resume starts a fresh exercise span. */
function pauseExercise() { endExercise(); }
function resumeExercise(exerciseId = null) { startExercise(exerciseId); }

/**
 * Whole activity object, with the freshest in-flight heartbeat applied.
 * Use this to render the Profile page.
 */
function getActivity() {
    _heartbeat(); // flush app-time so the UI sees up-to-date seconds
    // Flush any partial in-progress exercise too — otherwise viewing the
    // Profile mid-practice shows stale numbers.
    if (_exerciseActive) {
        const now = Date.now();
        const elapsedSec = Math.max(0, Math.round((now - _exerciseStartAt) / 1000));
        if (elapsedSec > 0) {
            _recordExercise(elapsedSec);
            _exerciseStartAt = now;
        }
    }
    return _load();
}

/** Compact stats for the Today + Totals cards. */
function getSummary() {
    const a = getActivity();
    const today = todayKey();
    const todayEntry = a.daily[today] || { appSec: 0, exerciseSec: 0 };

    let totalApp = 0, totalEx = 0, daysActive = 0;
    for (const e of Object.values(a.daily))   { totalApp += e.appSec || 0; totalEx += e.exerciseSec || 0; if ((e.appSec || 0) > 0) daysActive++; }
    for (const e of Object.values(a.weekly))  { totalApp += e.appSec || 0; totalEx += e.exerciseSec || 0; daysActive += (e.days || 0); }
    for (const e of Object.values(a.monthly)) { totalApp += e.appSec || 0; totalEx += e.exerciseSec || 0; daysActive += (e.days || 0); }

    return {
        todayAppSec: todayEntry.appSec || 0,
        todayExerciseSec: todayEntry.exerciseSec || 0,
        totalAppSec: totalApp,
        totalExerciseSec: totalEx,
        daysActive,
        streak: { ...a.streak },
    };
}

/** Replace the entire activity object (used by Reset). */
function reset() {
    _save(_emptyActivity());
}

/** Export the activity as a JSON string for download. */
function exportJson() {
    return JSON.stringify(_load(), null, 2);
}

/** Export the daily log as CSV for spreadsheets. */
function exportCsv() {
    const a = _load();
    const rows = ['date,app_minutes,exercise_minutes'];
    for (const [k, e] of Object.entries(a.daily).sort()) {
        rows.push(`${k},${Math.round((e.appSec||0)/60)},${Math.round((e.exerciseSec||0)/60)}`);
    }
    for (const [k, e] of Object.entries(a.weekly).sort()) {
        rows.push(`${k},${Math.round((e.appSec||0)/60)},${Math.round((e.exerciseSec||0)/60)}`);
    }
    for (const [k, e] of Object.entries(a.monthly).sort()) {
        rows.push(`${k},${Math.round((e.appSec||0)/60)},${Math.round((e.exerciseSec||0)/60)}`);
    }
    return rows.join('\n');
}

// ------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------

function _recordApp(sec) {
    if (sec <= 0) return;
    const activity = _load();
    const key = todayKey();
    const e = activity.daily[key] || { appSec: 0, exerciseSec: 0 };
    e.appSec += sec;
    activity.daily[key] = e;
    if (e.appSec > 0) _bumpStreak(activity);
    _save(activity);
}

function _recordExercise(sec) {
    if (sec <= 0) return;
    const activity = _load();
    const key = todayKey();
    const e = activity.daily[key] || { appSec: 0, exerciseSec: 0 };
    e.exerciseSec += sec;
    // Exercise time counts as app time too (it's happening inside the app).
    e.appSec = Math.max(e.appSec, e.exerciseSec);
    activity.daily[key] = e;
    _bumpStreak(activity);
    _save(activity);
}

function _heartbeat() {
    if (!_appSessionActive) return;
    const now = Date.now();
    const sinceInteraction = now - _lastInteraction;
    const sinceLastBeat = now - (_lastBeatAt || now);
    _lastBeatAt = now;

    // Only count time if the user was active within the idle window.
    if (sinceInteraction <= IDLE_TIMEOUT_MS) {
        const addSec = Math.min(
            Math.round(sinceLastBeat / 1000),
            Math.round(HEARTBEAT_MS / 1000) + 5 // cap at one beat + small slack
        );
        if (addSec > 0) _recordApp(addSec);
    }

    // Exercise counting is a separate span — handled by startExercise/endExercise.
    if (_exerciseActive) {
        // Treat exercise as continuous activity (Play was pressed → user intent).
        _lastInteraction = now;
    }
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------

const practiceTracker = {
    startAppSession,
    endAppSession,
    noteActivity,
    startExercise,
    endExercise,
    pauseExercise,
    resumeExercise,
    getActivity,
    getSummary,
    reset,
    exportJson,
    exportCsv,
    // helpers exposed for tests / UI
    _todayKey: todayKey,
    _weekKey: weekKey,
    _monthKey: monthKey,
};

export default practiceTracker;
