// ==UserScript==
// @name         GEM PurpleFox Copy Results
// @namespace    https://gem.fabtcg.com/
// @version      2.1.1
// @description  Send GEM pairings or results to a saved PurpleFox tournament, with clipboard export and debug logs.
// @match        https://gem.fabtcg.com/gem/*/run/*/report/
// @match        https://gem.fabtcg.com/gem/*/run/*/report/?*
// @match        https://eor-us.purple-fox.fr/*
// @run-at       document-start
// @noframes
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_openInTab
// ==/UserScript==

// PurpleFox export schema and result mapping adapted from
// "GEM PurpleFox Extract" v1.3.0 by Dan Collins and Aurélie Violette.
// https://github.com/dcollinsn/gem-tampermonkey

(function () {
    'use strict';

    const BUTTON_ID = 'gem-purplefox-copy-results';
    const PAIRINGS_BUTTON_ID = 'gem-purplefox-send-pairings';
    const STATUS_ID = 'gem-purplefox-copy-status';
    const BUTTON_LABEL = 'Send Results to PurpleFox';
    const RESULT_CODES = new Set(['', '1WIN', '2WIN', 'DRAW', 'LOSSALL']);
    const PURPLEFOX_ORIGIN = 'https://eor-us.purple-fox.fr';
    const KYOTO_URL = PURPLEFOX_ORIGIN + '/tournament/720567fe-2fcd-4cc1-8f65-3c70b0d46918?role=scorekeeper';
    const REQUEST_PREFIX = 'gem-purplefox-request:';
    const RESPONSE_PREFIX = 'gem-purplefox-response:';
    const DEBUG_LOG_KEY = 'gem-purplefox-debug-log';
    const PENDING_KEY = 'gem-purplefox-pending';
    const TRANSFER_TTL = 15 * 60 * 1000;
    const API_ORIGIN = 'https://upbcarvmkmyzhbosheyo.supabase.co';
    const AUTH_KEY = 'sb-upbcarvmkmyzhbosheyo-auth-token';
    // This is PurpleFox's public anonymous client key, not a user credential.
    const PUBLIC_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwYmNhcnZta215emhib3NoZXlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE2NTE5MjQ5NjIsImV4cCI6MTk2NzUwMDk2Mn0.Ris66avSM8Qf7yEpyziybP4fm6NB7MPWPR4pRIflamI';
    let copying = false;
    let sending = false;
    let logTransferId = null;

    function redactLog(value) {
        return String(value)
            .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
            .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]');
    }

    function safeLogData(value) {
        if (typeof value === 'string') return redactLog(value);
        if (Array.isArray(value)) return value.map(safeLogData);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeLogData(item)]));
        }
        return value;
    }

    function logEvent(level, event, details = {}) {
        // Log metadata and selected error fields, never request headers or
        // player payloads. Persist the latest 100 entries across tab reloads.
        const safeDetails = safeLogData(details);
        const entry = { time: new Date().toISOString(), transferId: logTransferId, level, event, ...safeDetails };
        console[level]('[GEM PurpleFox]', entry);
        try {
            const previous = GM_getValue(DEBUG_LOG_KEY, []);
            const entries = Array.isArray(previous) ? previous : [];
            GM_setValue(DEBUG_LOG_KEY, [...entries, entry].slice(-100));
        } catch (_) { /* Console logging remains available if storage fails. */ }
    }

    function copyDebugLog() {
        const log = { scriptVersion: '2.1.1', events: GM_getValue(DEBUG_LOG_KEY, []) };
        GM_setClipboard(JSON.stringify(log, null, 2), 'text', () => {
            window.alert('PurpleFox debug log copied. It includes request statuses and server error details. Request bodies and login tokens are excluded.');
        });
    }

    function ready(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else callback();
    }

    function normalizeDestination(value) {
        const url = new URL(value.trim());
        if (url.origin !== PURPLEFOX_ORIGIN || url.username || url.password ||
            !/^\/tournament\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/?$/i.test(url.pathname)) {
            throw new Error('Enter a PurpleFox tournament URL, such as https://eor-us.purple-fox.fr/tournament/<UUID>.');
        }
        url.hash = '';
        url.search = '?role=scorekeeper';
        return url.href;
    }

    function currentGemTournament() {
        const match = location.pathname.match(/^\/gem\/(\d+)\/run\/(\d+)\/report\/$/);
        if (!match) throw new Error('Open the GEM round report page first.');
        const heading = Array.from(document.querySelectorAll('h2')).find(el => /^\s*Round\s+\d+\b/i.test(el.textContent));
        const round = Number(heading?.textContent.match(/Round\s+(\d+)/i)?.[1]);
        if (!Number.isSafeInteger(round) || round < 1) throw new Error('Could not read the GEM round number.');
        return { gemId: match[1], roundId: match[2], round, name: document.querySelector('h1')?.textContent.trim() || `GEM ${match[1]}` };
    }

    function destinationFor(source, change = false) {
        const key = 'gem-purplefox-destination:' + source.gemId;
        const saved = GM_getValue(key, source.gemId === '488942' ? KYOTO_URL : '');
        if (!change && saved) return normalizeDestination(saved);
        const answer = window.prompt(`PurpleFox tournament URL for ${source.name} (GEM ${source.gemId}):`, saved);
        if (answer === null) return null;
        const destination = normalizeDestination(answer);
        GM_setValue(key, destination);
        return destination;
    }

    function setDestination() {
        try {
            const destination = destinationFor(currentGemTournament(), true);
            if (destination) showStatus('PurpleFox destination saved for this GEM tournament.');
        } catch (error) { showStatus(error.message, true); }
    }

    function updateSendButtons() {
        for (const id of [BUTTON_ID, PAIRINGS_BUTTON_ID]) {
            const button = document.getElementById(id);
            if (button) button.disabled = sending;
        }
    }

    function sendResults() { return sendTransfer('results'); }
    function sendPairings() { return sendTransfer('pairings'); }

    async function sendTransfer(kind) {
        if (sending) return;
        let id, listener, timeout;
        const finish = (message, isError = false) => {
            logEvent(isError ? 'error' : 'info', 'sender-finished', { message });
            sending = false;
            updateSendButtons();
            if (listener !== undefined) GM_removeValueChangeListener(listener);
            clearTimeout(timeout);
            if (id) {
                GM_deleteValue(REQUEST_PREFIX + id);
                GM_deleteValue(RESPONSE_PREFIX + id);
            }
            showStatus(message, isError);
        };
        try {
            const source = currentGemTournament();
            const matches = extractMatches(kind === 'results');
            const target = destinationFor(source);
            if (!target) return;
            id = crypto.randomUUID();
            logTransferId = id;
            sending = true;
            updateSendButtons();
            logEvent('info', 'transfer-started', { kind, gemId: source.gemId, round: source.round, target, matchCount: matches.length });
            let payload = { results: matches };
            if (kind === 'pairings') {
                showStatus('Preparing GEM pairings…');
                payload = await preparePairings(source, matches);
            }
            GM_setValue(REQUEST_PREFIX + id, { id, kind, createdAt: Date.now(), source, target, ...payload });
            listener = GM_addValueChangeListener(RESPONSE_PREFIX + id, (_key, _old, response) => {
                if (!response) return;
                if (response.state === 'done') finish(response.message);
                else if (response.state === 'error') finish(response.message, true);
                else if (response.message) showStatus(response.message);
            });
            showStatus(`Opening PurpleFox to send ${matches.length} ${kind === 'pairings' ? 'pairings' : 'matches'} from round ${source.round}…`);
            timeout = setTimeout(() => finish('Transfer expired. Check PurpleFox, then send again.', true), TRANSFER_TTL);
            GM_openInTab(target + '#gem-purplefox-transfer=' + id, { active: true, insert: true, setParent: true });
        } catch (error) { finish(error.message || 'Could not send results.', true); }
    }

    function parsePairings(text) {
        if (typeof text !== 'string' || !text.trim()) throw new Error('The transfer contains no pairings.');
        const matches = new Map();
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const fields = line.split('\t').map(field => field.trim());
            if (!/^\d+$/.test(fields[0])) throw new Error('Could not read a pairing table number.');
            const tableNumber = Number(fields[0]);
            if (fields.length >= 6) {
                // GEM's print-by-table layout: table, name, ID, name, ID,
                // and "points - points". This is PurpleFox's FAB parser format.
                const scores = fields[5].match(/^(\d+(?:\.\d+)?)\s+-\s+(\d+(?:\.\d+)?)$/);
                if (!scores && fields[5] && fields[5] !== '-') throw new Error(`Could not read the pairing points at table ${tableNumber}.`);
                const opponentIsBye = /^bye$/i.test(fields[3]);
                const match = {
                    tableNumber, playerName1: fields[1], playerGameId1: fields[2],
                    playerName2: opponentIsBye ? null : fields[3],
                    playerGameId2: fields[4] === '-' || opponentIsBye ? null : fields[4],
                    playerScore1: scores?.[1] ?? null, playerScore2: scores?.[2] ?? null
                };
                if (matches.has(tableNumber) && JSON.stringify(matches.get(tableNumber)) !== JSON.stringify(match)) {
                    throw new Error(`Conflicting pairings at table ${tableNumber}.`);
                }
                matches.set(tableNumber, match);
            } else if (fields.length === 3) {
                // PurpleFox also accepts one table/name/ID line per player.
                const match = matches.get(tableNumber);
                if (match) {
                    if (match.playerGameId2 !== null || match.playerGameId1 === fields[2]) throw new Error(`Duplicate players at table ${tableNumber}.`);
                    match.playerName2 = fields[1];
                    match.playerGameId2 = fields[2];
                } else matches.set(tableNumber, {
                    tableNumber, playerName1: fields[1], playerGameId1: fields[2],
                    playerName2: null, playerGameId2: null, playerScore1: null, playerScore2: null
                });
            } else throw new Error(`Could not read the pairing at table ${tableNumber}.`);
        }
        if (!matches.size) throw new Error('No pairings were found.');
        return Array.from(matches.values()).sort((a, b) => a.tableNumber - b.tableNumber);
    }

    async function preparePairings(source, matches) {
        const url = new URL(`/gem/${source.gemId}/run/${source.roundId}/print/?order=table`, location.origin);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let pairings, parsed;
        try {
            const response = await fetch(url.href, { credentials: 'same-origin', signal: controller.signal });
            if (!response.ok) throw new Error(`GEM pairing print request failed (HTTP ${response.status}).`);
            if (response.url && new URL(response.url).pathname !== url.pathname) throw new Error('GEM redirected the pairing print request.');
            const printDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
            const lines = [];
            for (const row of printDocument.querySelectorAll('tr')) {
                const fields = Array.from(row.children)
                    .filter(cell => cell.matches('td, th'))
                    .map(cell => cell.textContent.replace(/\s+/g, ' ').trim());
                if (/^\d+$/.test(fields[0] || '') && (fields.length === 3 || fields.length >= 6)) {
                    lines.push(fields.slice(0, fields.length >= 6 ? 6 : 3).join('\t'));
                }
            }
            pairings = lines.join('\n');
            parsed = parsePairings(pairings);
        } catch (error) {
            // The report page always supplies table/name/ID rows, another
            // format accepted by PurpleFox. Do not invent unavailable points.
            logEvent('warn', 'pairings-print-fallback', { message: error.message });
            const lines = [];
            for (const row of [...matches].sort((a, b) => a.tableNumber - b.tableNumber)) {
                for (const seat of [1, 2]) {
                    if (row[`playerGameId${seat}`] !== null) {
                        lines.push([row.tableNumber, row[`playerName${seat}`], row[`playerGameId${seat}`]].join('\t'));
                    }
                }
            }
            return { pairings: lines.join('\n'), pairingSource: 'report' };
        } finally { clearTimeout(timer); }
        const expected = new Map(matches.map(row => [row.tableNumber, row]));
        const playerIds = row => [row.playerGameId1, row.playerGameId2].filter(id => id !== null).sort().join(',');
        if (parsed.length !== matches.length || parsed.some(row => !expected.has(row.tableNumber) || playerIds(row) !== playerIds(expected.get(row.tableNumber)))) {
            throw new Error('The GEM pairing print page differs from the match page. Refresh GEM before sending pairings.');
        }
        logEvent('info', 'pairings-print-ready', { matchCount: parsed.length });
        return { pairings, pairingSource: 'print' };
    }

    // The receiver runs on PurpleFox. Its login token stays on that origin;
    // only match data and a completion message cross between the two tabs.
    function receiverMessage(message, isError = false) {
        let panel = document.getElementById('gem-purplefox-transfer-status');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'gem-purplefox-transfer-status';
            panel.setAttribute('role', 'status');
            panel.setAttribute('aria-live', 'polite');
            panel.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:min(440px,calc(100vw - 32px));padding:16px;border:2px solid #b88bd6;border-radius:8px;background:#21172b;color:#fff;font:15px/1.5 sans-serif;white-space:pre-line;box-shadow:0 4px 20px #0008;';
            document.body.append(panel);
        }
        panel.style.borderColor = isError ? '#ff9696' : '#b88bd6';
        panel.textContent = 'GEM → PurpleFox\n' + message;
    }

    function loggedInToken() {
        try {
            const session = JSON.parse(localStorage.getItem(AUTH_KEY));
            if (typeof session?.access_token === 'string' && session.expires_at * 1000 > Date.now() + 15000) {
                return session.access_token;
            }
        } catch (_) { /* PurpleFox's own login/refresh will create the session. */ }
        return null;
    }

    async function apiRequest(resource, token, params = {}, data, writeMethod = 'POST') {
        const url = new URL(API_ORIGIN + '/rest/v1/' + resource);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
        const method = data === undefined ? 'GET' : writeMethod;
        const submittedRows = Array.isArray(data) ? data.length : undefined;
        const started = Date.now();
        const metadata = { method, resource, submittedRows };
        logEvent('info', 'request-started', metadata);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(url.href, {
                method,
                credentials: 'omit',
                signal: controller.signal,
                headers: {
                    apikey: PUBLIC_API_KEY,
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    // Match PurpleFox's native upsert: HTTP success confirms
                    // the request; returning a copy of every row is optional.
                    ...(data === undefined ? {} : { Prefer: (method === 'POST' ? 'resolution=merge-duplicates,' : '') + 'return=minimal' })
                },
                ...(data === undefined ? {} : { body: JSON.stringify(data) })
            });
            const text = await response.text();
            let body = null;
            let validJson = true;
            if (text.trim()) {
                try { body = JSON.parse(text); }
                catch (_) { validJson = false; }
            }
            const summary = {
                ...metadata, status: response.status, elapsedMs: Date.now() - started,
                responseKind: !text.trim() ? 'empty' : !validJson ? 'non-JSON' : Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body,
                returnedRows: Array.isArray(body) ? body.length : null,
                contentRange: response.headers.get('content-range'),
                preferenceApplied: response.headers.get('preference-applied')
            };
            if (!response.ok) {
                const serverError = {};
                for (const key of ['code', 'message', 'details', 'hint']) {
                    if (typeof body?.[key] === 'string') serverError[key] = body[key];
                }
                logEvent('error', 'request-failed', { ...summary, serverError });
                const hint = response.status === 401 || response.status === 403 ? ' Check your PurpleFox login and scorekeeper permissions.' : '';
                const detail = serverError.message ? ': ' + redactLog(serverError.message) : '';
                const code = serverError.code ? '; ' + redactLog(serverError.code) : '';
                throw Object.assign(new Error(`PurpleFox ${resource} request failed (HTTP ${response.status}${code})${detail}.${hint}`), { logged: true });
            }
            logEvent('info', 'request-succeeded', summary);
            if (!validJson) {
                throw new Error(`PurpleFox ${resource} returned an unexpected non-JSON response (HTTP ${response.status}). Check the Network response in the PurpleFox tab.`);
            }
            return body;
        } catch (error) {
            if (!error.logged) {
                logEvent('error', 'request-error', { ...metadata, elapsedMs: Date.now() - started, message: error.message, name: error.name });
                if (method !== 'GET') {
                    throw new Error(`PurpleFox ${resource} request could not be confirmed: ${error.message}. Check PurpleFox before sending again; the save outcome is unknown.`);
                }
            }
            throw error;
        } finally { clearTimeout(timer); }
    }

    function validateTransfer(request, id) {
        if (!request || request.id !== id || !Number.isFinite(request.createdAt) ||
            Date.now() - request.createdAt > TRANSFER_TTL || request.createdAt > Date.now() + 60000) {
            throw new Error('This transfer has expired. Send the results again from GEM.');
        }
        if (request.target !== normalizeDestination(request.target)) throw new Error('Invalid PurpleFox destination.');
        if (!Number.isSafeInteger(request.source?.round) || request.source.round < 1) throw new Error('Missing GEM round number.');
        const kind = request.kind || 'results';
        if (!['results', 'pairings'].includes(kind)) throw new Error('Unrecognized transfer type.');
        const matches = kind === 'pairings' ? parsePairings(request.pairings) : request.results;
        if (!Array.isArray(matches) || !matches.length) throw new Error('The transfer contains no matches.');
        const seen = new Set();
        for (const row of matches) {
            if (!Number.isSafeInteger(row.tableNumber) || seen.has(row.tableNumber) ||
                (kind === 'results' && !RESULT_CODES.has(row.result === null ? '' : row.result))) throw new Error('Invalid or duplicate match data.');
            seen.add(row.tableNumber);
            for (const seat of [1, 2]) {
                if (row[`playerGameId${seat}`] !== null &&
                    (typeof row[`playerGameId${seat}`] !== 'string' || !/^\d+$/.test(row[`playerGameId${seat}`]))) throw new Error('Invalid GEM player ID.');
                if (row[`playerName${seat}`] !== null && typeof row[`playerName${seat}`] !== 'string') throw new Error('Invalid player name.');
            }
        }
        return { kind, matches };
    }

    async function importToPurpleFox(request, token) {
        const { kind, matches } = validateTransfer(request, request.id);
        const targetId = new URL(request.target).pathname.split('/')[2];
        const tournaments = await apiRequest('tournaments', token, {
            select: 'id,name,game,software,round,firstTable,lastTable', id: 'eq.' + targetId
        });
        if (!Array.isArray(tournaments) || tournaments.length !== 1) throw new Error('PurpleFox tournament not found or you do not have access.');
        const tournament = tournaments[0];
        if (tournament.game !== 'fab' || tournament.software === 'wltr') throw new Error('The destination must be a Flesh and Blood tournament using GEM results.');
        if (Number(tournament.round) !== request.source.round) {
            throw new Error(`Round mismatch: GEM is round ${request.source.round}; ${tournament.name} is round ${tournament.round}. Set the correct round in PurpleFox, then send again.`);
        }
        if (kind === 'pairings') {
            const firstTable = Math.min(...matches.map(row => row.tableNumber));
            const lastTable = Math.max(...matches.map(row => row.tableNumber));
            const rangeChanged = firstTable !== Number(tournament.firstTable) || lastTable !== Number(tournament.lastTable);
            if (rangeChanged) {
                // Equivalent to choosing "Change table to ..." in PurpleFox's
                // native pairing-import confirmation, for both growth and shrinkage.
                logEvent('info', 'table-range-update-started', {
                    targetId, previousFirstTable: tournament.firstTable, previousLastTable: tournament.lastTable,
                    firstTable, lastTable
                });
                try {
                    await apiRequest('tournaments', token, { id: 'eq.' + targetId }, { firstTable, lastTable }, 'PATCH');
                } catch (error) {
                    throw new Error('Could not confirm the PurpleFox table range update; pairings were not sent. ' + error.message);
                }
                logEvent('info', 'table-range-updated', { targetId, firstTable, lastTable });
            }
            // Native pairing imports only upsert player identities and points.
            // Result and table-status fields are not part of this operation.
            const tables = matches.map(row => ({ ...row, tournamentId: targetId }));
            try {
                await apiRequest('tables', token, {}, tables);
            } catch (error) {
                if (rangeChanged) {
                    throw new Error(`PurpleFox's table range was updated to ${firstTable}–${lastTable}, but the pairing import did not complete. ` + error.message);
                }
                throw error;
            }
            return `Sent ${tables.length} pairings to ${tournament.name}, round ${request.source.round}.` +
                (rangeChanged ? ` Table range updated to ${firstTable}–${lastTable}.` : '') +
                (request.pairingSource === 'report' ? ' Points were unavailable; pairings were built from the GEM match page.' : '');
        }
        if (matches.some(row => row.tableNumber < Number(tournament.firstTable) || row.tableNumber > Number(tournament.lastTable))) {
            throw new Error(`The GEM tables are outside PurpleFox's range (${tournament.firstTable}–${tournament.lastTable}). Adjust the table range in PurpleFox, then send again.`);
        }
        const existing = new Map();
        for (let offset = 0; ; offset += 1000) {
            const rows = await apiRequest('tables', token, {
                select: 'tableNumber,playerGameId1,playerGameId2,playerScore1,playerScore2',
                tournamentId: 'eq.' + targetId, order: 'tableNumber.asc', limit: '1000', offset: String(offset)
            });
            if (!Array.isArray(rows)) throw new Error('Could not read the current PurpleFox tables.');
            rows.forEach(row => existing.set(String(row.tableNumber), row));
            if (rows.length < 1000) break;
        }
        // Match PurpleFox's FAB import: valid results are at stage; completed
        // tables are marked done. Preserve scores when player seats are swapped.
        const tables = matches.map(row => {
            const old = existing.get(String(row.tableNumber));
            const swapped = old && row.playerGameId1 === old.playerGameId2 && row.playerGameId2 === old.playerGameId1;
            return {
                tableNumber: row.tableNumber, tournamentId: targetId,
                playerName1: row.playerName1, playerGameId1: row.playerGameId1,
                playerName2: row.playerName2, playerGameId2: row.playerGameId2,
                result: row.result, isAtStage: row.result !== null,
                playerScore1: (swapped ? old.playerScore2 : old?.playerScore1) ?? null,
                playerScore2: (swapped ? old.playerScore1 : old?.playerScore2) ?? null
            };
        });
        await apiRequest('tables', token, {}, tables);
        const completed = tables.filter(row => row.isAtStage).map(row => ({ tournamentId: targetId, tableNumber: row.tableNumber, status: 'done' }));
        if (completed.length) {
            try {
                await apiRequest('table_status', token, {}, completed);
            } catch (error) {
                throw new Error('Match results were saved, but marking completed tables done failed. Check PurpleFox. ' + error.message);
            }
        }
        return `Sent ${tables.length} matches to ${tournament.name}, round ${request.source.round} (${completed.length} completed, ${tables.length - completed.length} unfinished).`;
    }

    async function receiveTransfer(id) {
        logTransferId = id;
        const reply = (state, message) => {
            logEvent(state === 'error' ? 'error' : 'info', 'receiver-' + state, { message });
            receiverMessage(message, state === 'error');
            GM_setValue(RESPONSE_PREFIX + id, { state, message });
        };
        let redirecting = false;
        try {
            let request = GM_getValue(REQUEST_PREFIX + id);
            const { kind, matches } = validateTransfer(request, id);
            const targetId = new URL(request.target).pathname.split('/')[2];
            const pageId = location.pathname.match(/^\/tournament\/([^/]+)\/?$/)?.[1];
            if (pageId !== targetId) {
                // Keep the pending transfer through PurpleFox's login redirect.
                reply('waiting', 'Log in to PurpleFox to continue sending the GEM results.');
            }
            let token = loggedInToken();
            if (!token) reply('waiting', 'Log in to PurpleFox in this tab. Your GEM results will be sent after login.');
            while (!token) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                request = GM_getValue(REQUEST_PREFIX + id);
                validateTransfer(request, id);
                token = loggedInToken();
            }
            if (location.pathname.match(/^\/tournament\/([^/]+)\/?$/)?.[1] !== targetId) {
                redirecting = true;
                location.assign(request.target + '#gem-purplefox-transfer=' + id);
                return;
            }
            if (request.importing) throw new Error('The previous transfer was interrupted. Check PurpleFox, then send again from GEM.');
            GM_setValue(REQUEST_PREFIX + id, { ...request, importing: true });
            reply('sending', `Sending ${matches.length} ${kind === 'pairings' ? 'pairings' : 'matches'} from ${request.source.name}, round ${request.source.round}…`);
            const message = await importToPurpleFox(request, token);
            reply('done', message);
        } catch (error) { reply('error', error.message || 'Could not send results.'); }
        finally {
            // On a login redirect, keep the request for the next page load.
            if (!redirecting) {
                GM_deleteValue(REQUEST_PREFIX + id);
                sessionStorage.removeItem(PENDING_KEY);
            }
        }
    }

    ready(() => GM_registerMenuCommand('Copy PurpleFox debug log', copyDebugLog));

    if (location.origin === PURPLEFOX_ORIGIN) {
        const hashId = location.hash.match(/^#gem-purplefox-transfer=([0-9a-f-]{36})$/i)?.[1];
        if (hashId) {
            sessionStorage.setItem(PENDING_KEY, hashId);
            history.replaceState(history.state, '', location.pathname + location.search);
        }
        const id = hashId || sessionStorage.getItem(PENDING_KEY);
        if (id) ready(() => {
            // Only one tab may handle a transfer. An interrupted request is
            // reported rather than automatically repeating database writes.
            navigator.locks.request('gem-purplefox:' + id, { ifAvailable: true }, lock => {
                if (lock) return receiveTransfer(id);
                receiverMessage('This transfer is already being handled in another PurpleFox tab.');
            }).catch(() => receiverMessage('Could not start the transfer. Send again from GEM.', true));
        });
        return;
    }

    function readPlayer(cell, tableNumber) {
        // textContent decodes HTML entities and handles names split over lines.
        // Match the name/ID before the nested Assign Match Hero link.
        const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        const match = text.match(/^(.+?)\s+\((\d+)\)/);
        if (match) return { name: match[1], id: match[2] };
        if (!text || /^(?:[-\s]*bye[-\s]*)$/i.test(text)) {
            return { name: null, id: null };
        }
        throw new Error(`Could not read a player name and GEM ID at table ${tableNumber}.`);
    }

    function extractResults() { return extractMatches(true); }

    function extractMatches(includeResults) {
        const results = [];
        // Include rows hidden by Hide Complete or the table filter.
        for (const row of document.querySelectorAll('.match-row')) {
            const cells = row.querySelectorAll('.match-element');
            const tableText = (cells[0]?.textContent || '').trim();
            const tableNumber = Number(tableText);
            const select = cells[3]?.querySelector('select');
            if (cells.length < 3 || !tableText || !Number.isSafeInteger(tableNumber) || (includeResults && !select)) {
                throw new Error('A match row could not be read. Nothing was copied.');
            }
            const player1 = readPlayer(cells[1], tableNumber);
            const player2 = readPlayer(cells[2], tableNumber);
            if (player1.id === null && player2.id === null) continue;
            if (includeResults && !RESULT_CODES.has(select.value)) {
                throw new Error(`Unrecognized result at table ${tableNumber}: ${select.value}`);
            }
            // Keep the exact keys, string IDs, and result values used by the
            // reference extension. An unfinished match has result: null.
            results.push({
                tableNumber,
                playerName1: player1.name,
                playerGameId1: player1.id,
                playerName2: player2.name,
                playerGameId2: player2.id,
                ...(includeResults ? { result: select.value || null } : {})
            });
        }
        if (!results.length) throw new Error('No matches were found to copy.');
        return results;
    }

    function showStatus(message, isError = false) {
        const status = document.getElementById(STATUS_ID);
        if (status) {
            status.textContent = message;
            status.style.color = isError ? '#ffb4b4' : 'inherit';
        }
        if (isError) window.alert(`PurpleFox export: ${message}`);
    }

    function copyResults() {
        if (copying) return;
        const button = document.getElementById(BUTTON_ID);
        try {
            const results = extractResults();
            const unfinished = results.filter(match => match.result === null).length;
            copying = true;
            if (button) button.disabled = true;
            showStatus('Copying results…');
            // Report success after Tampermonkey confirms the clipboard write.
            GM_setClipboard(JSON.stringify(results), 'text', function () {
                copying = false;
                if (button) button.disabled = sending;
                showStatus(`Copied ${results.length} matches to clipboard` +
                    (unfinished ? ` (${unfinished} unfinished).` : '.'));
            });
        } catch (error) {
            copying = false;
            if (button) button.disabled = sending;
            showStatus(error.message || 'Could not copy results.', true);
        }
    }

    function addSendButtons() {
        const acceptAll = Array.from(document.querySelectorAll('a[href]')).find(link =>
            /\/report\/all\/accept\/?$/.test(new URL(link.href, location.href).pathname)
        );
        if (!acceptAll) return;
        // Let the actions wrap on narrow screens, as the Reports heading does.
        if (acceptAll.parentElement.style.flexWrap !== 'wrap') {
            acceptAll.parentElement.style.flexWrap = 'wrap';
        }

        let button = document.getElementById(BUTTON_ID);
        if (!button) {
            button = document.createElement('button');
            button.id = BUTTON_ID;
            button.type = 'button';
            button.className = 'fab-btn';
            button.textContent = BUTTON_LABEL;
            button.title = 'Send all matches to the saved PurpleFox tournament, including hidden and unfinished matches.';
            button.style.marginRight = '0.5rem';
            button.disabled = sending;
            button.addEventListener('click', sendResults);
        }
        if (acceptAll.previousElementSibling !== button) acceptAll.before(button);

        let pairingsButton = document.getElementById(PAIRINGS_BUTTON_ID);
        if (!pairingsButton) {
            pairingsButton = document.createElement('button');
            pairingsButton.id = PAIRINGS_BUTTON_ID;
            pairingsButton.type = 'button';
            pairingsButton.className = 'fab-btn';
            pairingsButton.textContent = 'Send Pairings to PurpleFox';
            pairingsButton.title = 'Send table numbers, player names and GEM IDs, with points from the pairing print page when available.';
            pairingsButton.style.marginRight = '0.5rem';
            pairingsButton.disabled = sending;
            pairingsButton.addEventListener('click', sendPairings);
        }
        if (button.previousElementSibling !== pairingsButton) button.before(pairingsButton);

        if (!document.getElementById(STATUS_ID)) {
            const status = document.createElement('div');
            status.id = STATUS_ID;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.style.cssText = 'font-size:0.9em; margin-bottom:0.75rem;';
            // Place feedback below the Reports heading/actions, outside the
            // reports list that GEM refreshes automatically.
            acceptAll.parentElement.parentElement.after(status);
        }
    }

    ready(() => {
        GM_registerMenuCommand('PurpleFox Export (copy JSON)', copyResults, 'e');
        GM_registerMenuCommand('Send results to PurpleFox', sendResults);
        GM_registerMenuCommand('Send pairings to PurpleFox', sendPairings);
        GM_registerMenuCommand('Set PurpleFox destination for this tournament', setDestination);
        addSendButtons();
        // Restore the button if GEM inserts or replaces its controls after loading.
        new MutationObserver(addSendButtons).observe(document.body, { childList: true, subtree: true });
    });
})();
