/**
 * @fileoverview localStorage wrapper with namespaced keys for Swaradhana.
 *
 * All keys stored by this module are prefixed with "swaradhana_" to avoid
 * collisions with other apps sharing the same origin.
 *
 * @module storage
 */

import { STORAGE_KEYS } from './config.js';

/** Namespace prefix applied to every localStorage key. */
const NAMESPACE = 'swaradhana_';

/**
 * Persist a value to localStorage under a namespaced key.
 *
 * @param {string} key   - A constant from {@link STORAGE_KEYS}.
 * @param {*}      data  - Any JSON-serialisable value.
 * @throws {DOMException} If the storage quota is exceeded.
 */
export function save(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (err) {
        console.error(`[storage] Failed to save key "${key}":`, err);
        throw err;
    }
}

/**
 * Retrieve and deserialise a value from localStorage.
 *
 * @param {string} key            - A constant from {@link STORAGE_KEYS}.
 * @param {*}      [defaultValue=null] - Returned when the key does not exist
 *                                       or the stored JSON is malformed.
 * @returns {*} The parsed value, or {@link defaultValue}.
 */
export function load(key, defaultValue = null) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) {
            return defaultValue;
        }
        return JSON.parse(raw);
    } catch (err) {
        console.warn(
            `[storage] Failed to parse key "${key}". Returning default value.`,
            err
        );
        return defaultValue;
    }
}

/**
 * Remove a single key from localStorage.
 *
 * @param {string} key - A constant from {@link STORAGE_KEYS}.
 */
export function remove(key) {
    localStorage.removeItem(key);
}

/**
 * Estimate the current localStorage usage.
 *
 * The estimate is based on the byte-length of every key+value pair
 * (UTF-16: 2 bytes per character).  The total capacity is assumed to be
 * 5 MB which is the de-facto limit in most browsers.
 *
 * @returns {{ usedBytes: number, totalBytes: number, percentage: number }}
 */
export function getStorageUsage() {
    const TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB assumed quota
    let usedChars = 0;

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const value = localStorage.getItem(key);
        // Each JS char occupies 2 bytes in the UTF-16 storage model.
        usedChars += key.length + (value ? value.length : 0);
    }

    const usedBytes = usedChars * 2;
    const percentage = Math.round((usedBytes / TOTAL_BYTES) * 10000) / 100;

    return { usedBytes, totalBytes: TOTAL_BYTES, percentage };
}

/**
 * Export all Swaradhana data for backup.
 *
 * Iterates every localStorage key that starts with the {@link NAMESPACE}
 * prefix and returns a plain object mapping each key to its parsed value.
 *
 * @returns {Object<string, *>} A JSON-safe object suitable for download or
 *                              clipboard copy.
 */
export function exportAllData() {
    const data = {};

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(NAMESPACE)) {
            try {
                data[key] = JSON.parse(localStorage.getItem(key));
            } catch {
                // Store raw string if it isn't valid JSON.
                data[key] = localStorage.getItem(key);
            }
        }
    }

    return data;
}

/**
 * Restore Swaradhana data from a backup object.
 *
 * Each key in the provided object is written to localStorage as a
 * JSON-stringified value.  Existing keys are overwritten.
 *
 * @param {Object<string, *>} jsonData - The backup object previously
 *                                       returned by {@link exportAllData}.
 */
export function importAllData(jsonData) {
    if (!jsonData || typeof jsonData !== 'object') {
        console.error('[storage] importAllData: invalid data provided.');
        return;
    }

    for (const [key, value] of Object.entries(jsonData)) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
            console.error(`[storage] Failed to import key "${key}":`, err);
        }
    }
}

/**
 * Remove **all** localStorage entries whose key starts with the Swaradhana
 * namespace prefix ({@link NAMESPACE}).
 *
 * **Important:** The caller is responsible for obtaining user confirmation
 * before invoking this function — no confirmation dialog is shown here.
 */
export function clearAllData() {
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(NAMESPACE)) {
            keysToRemove.push(key);
        }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
}
