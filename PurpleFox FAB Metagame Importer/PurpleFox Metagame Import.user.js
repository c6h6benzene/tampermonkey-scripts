// ==UserScript==
// @name         PurpleFox Metagame Import
// @namespace    local.fab-events
// @version      1.0.0
// @description  Import player JSON or hero counts into the Stage Tools metagame chart.
// @match        https://eor-us.purple-fox.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const suppliedCounts = [{"hero":"Ira, Crimson Haze (LL)","count":18},{"hero":"Bravo, Flattering Showman","count":10},{"hero":"Olympia","count":7},{"hero":"Hala","count":6},{"hero":"Iyslander (LL)","count":4},{"hero":"Dromai","count":4},{"hero":"Dorinthea","count":4},{"hero":"Kayo","count":4},{"hero":"Kano (LL)","count":3},{"hero":"Levia","count":3},{"hero":"Fai","count":3},{"hero":"Viserai, Between Worlds","count":3},{"hero":"Lexi","count":3},{"hero":"Florian","count":3},{"hero":"Enigma","count":3},{"hero":"Dash (LL)","count":2},{"hero":"Benji, the Piercing Wind","count":2},{"hero":"Riptide","count":2},{"hero":"Valda Brightaxe","count":2},{"hero":"Verdance","count":2},{"hero":"Arakni, Web of Deceit","count":1},{"hero":"Vynnset","count":1},{"hero":"Victor Goldmane (LL)","count":1},{"hero":"Rhinar (LL)","count":1},{"hero":"Kassai, Cintari Sellsword (LL)","count":1},{"hero":"Lyath Goldmane","count":1},{"hero":"Dorinthea, Quicksilver Prodigy","count":1},{"hero":"Aurora","count":1}];

    function normalize(value) {
        return String(value).normalize('NFKC').replace(/\s*\(LL\)\s*$/i, '')
            .replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function parseCounts(text) {
        const input = text.replace(/^\uFEFF/, '').trim();
        if (!input) throw new Error('Paste player JSON or hero counts first.');
        let rows;
        if (/^[\[{]/.test(input)) {
            const parsed = JSON.parse(input);
            rows = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([hero, count]) => ({ hero, count }));
        } else {
            rows = input.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
                const cells = line.split('\t');
                if (cells.length !== 2) throw new Error(`Line ${i + 1}: use Hero, then a tab, then Count.`);
                if (i === 0 && /^hero$/i.test(cells[0].trim()) && /^count$/i.test(cells[1].trim())) return null;
                if (!cells[1].trim()) throw new Error(`Line ${i + 1}: count is missing.`);
                return { hero: cells[0], count: Number(cells[1]) };
            }).filter(Boolean);
        }
        if (!rows.length) throw new Error('No hero records found.');
        const counts = new Map();
        const playerIds = new Set();
        for (const [index, row] of rows.entries()) {
            if (!row || typeof row.hero !== 'string' || !row.hero.trim()) {
                throw new Error(`Record ${index + 1}: hero must be a nonempty name or PurpleFox ID.`);
            }
            const count = Object.hasOwn(row, 'count') ? row.count : 1;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
                throw new Error(`Record ${index + 1}: count must be a nonnegative whole number.`);
            }
            if (!Object.hasOwn(row, 'count') && row.gameId != null && String(row.gameId).trim()) {
                const playerId = String(row.gameId).trim();
                if (playerIds.has(playerId)) throw new Error(`Duplicate player gameId: ${playerId}`);
                playerIds.add(playerId);
            }
            const key = row.hero.trim();
            const total = (counts.get(key) || 0) + count;
            if (!Number.isSafeInteger(total)) throw new Error('Count is too large.');
            counts.set(key, total);
        }
        return [...counts].map(([hero, count]) => ({ hero, count }));
    }

    function matchCounts(rows, heroesById) {
        const names = new Map();
        for (const [id, hero] of Object.entries(heroesById)) {
            if (!hero || typeof hero.label !== 'string') continue;
            const key = normalize(hero.label);
            names.set(key, [...(names.get(key) || []), id]);
        }
        const result = new Map();
        const errors = [];
        for (const row of rows) {
            const candidates = Object.hasOwn(heroesById, row.hero) ? [row.hero] : names.get(normalize(row.hero)) || [];
            if (candidates.length !== 1) {
                errors.push(`${row.hero}: ${candidates.length ? 'ambiguous name; use a PurpleFox hero ID' : 'no matching PurpleFox hero'}`);
            } else {
                const id = candidates[0];
                result.set(id, (result.get(id) || 0) + row.count);
            }
        }
        if (errors.length) throw new Error(errors.join('\n'));
        const mapped = [...result].map(([hero, count]) => ({ hero, count }));
        if (!mapped.length || !mapped.some(row => row.count > 0)) throw new Error('The total player count must be greater than zero.');
        const total = mapped.reduce((sum, row) => sum + row.count, 0);
        if (!Number.isSafeInteger(total)) throw new Error('Total count is too large.');
        return mapped.sort((a, b) => b.count - a.count || heroesById[a.hero].label.localeCompare(heroesById[b.hero].label));
    }

    function isMetagame(vm) {
        return vm && Array.isArray(vm.$data?.metagame) && vm.heroesById && vm.game === 'fab'
            && typeof vm.onHeroSelection === 'function' && typeof vm.exportMetagame === 'function';
    }

    function findMetagame(doc) {
        const root = doc.querySelector('#app');
        if (!root) throw new Error('PurpleFox app was not found.');
        const queue = [root.__vue_app__?._instance];
        const visited = new Set();
        for (const element of root.querySelectorAll('*')) {
            if (element.__vueParentComponent) queue.push(element.__vueParentComponent);
        }
        while (queue.length) {
            const node = queue.pop();
            if (!node || typeof node !== 'object' || visited.has(node)) continue;
            visited.add(node);
            if (isMetagame(node.proxy)) return node.proxy;
            for (const child of [node.parent, node.component, node.subTree, node.suspense?.activeBranch]) {
                if (child) queue.push(child);
            }
            if (Array.isArray(node.children)) queue.push(...node.children);
        }
        throw new Error('Open Stage Tools → Metagame. If it is already open, PurpleFox may have changed its page code.');
    }

    async function applyCounts(vm, rows) {
        if (!isMetagame(vm)) throw new Error('The metagame page is no longer open.');
        const previous = { vm, rows: vm.$data.metagame.map(row => ({ ...row })), usePercent: vm.usePercent };
        try {
            vm.$data.metagame = rows.map(row => ({ ...row }));
            vm.usePercent = false;
            await vm.$nextTick();
            if (JSON.stringify(vm.$data.metagame) !== JSON.stringify(rows)) throw new Error('The page did not accept the counts.');
        } catch (error) {
            vm.$data.metagame = previous.rows;
            vm.usePercent = previous.usePercent;
            await vm.$nextTick();
            throw error;
        }
        return previous;
    }

    if (typeof module === 'object' && module.exports) {
        module.exports = { normalize, parseCounts, matchCounts, findMetagame, applyCounts };
        return;
    }
    if (typeof document === 'undefined' || window.top !== window.self) return;

    let previous = null;
    let preview = null;
    const launch = document.createElement('button');
    launch.textContent = 'Import metagame';
    launch.type = 'button';
    launch.style.cssText = 'position:fixed;bottom:22px;right:24px;z-index:2147483000;background:#814ab7;color:white;border:2px solid white;border-radius:6px;padding:12px 18px;font:600 15px Arial;cursor:pointer;box-shadow:0 2px 10px #0004;display:none';
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:700px;max-width:92vw;max-height:90vh;overflow:auto;border:1px solid #814ab7;border-radius:8px;padding:22px;color:#222;background:#fff;font:14px Arial';
    dialog.innerHTML = '<h2 style="margin-top:0">Import metagame</h2>'
        + '<p>Paste player JSON, hero-count JSON, or two columns copied from Excel: Hero and Count.</p>'
        + '<p>The supplied 96-player data is prefilled. Applying replaces the current chart. Undo restores the previous chart.</p>'
        + '<input type="file" accept=".json,.txt,.tsv,application/json,text/plain" aria-label="Load hero data file">'
        + '<textarea aria-label="Hero data" spellcheck="false" style="display:block;box-sizing:border-box;width:100%;height:190px;margin:12px 0;font:13px monospace"></textarea>'
        + '<pre aria-live="polite" style="white-space:pre-wrap;max-height:260px;overflow:auto;background:#f4f0f8;padding:12px"></pre>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" data-action="preview">Preview counts</button>'
        + '<button type="button" data-action="apply" disabled>Apply counts</button>'
        + '<button type="button" data-action="undo" disabled>Undo last import</button>'
        + '<button type="button" data-action="close">Close</button></div>';
    const input = dialog.querySelector('textarea');
    const output = dialog.querySelector('pre');
    const apply = dialog.querySelector('[data-action="apply"]');
    const undo = dialog.querySelector('[data-action="undo"]');
    input.value = JSON.stringify(suppliedCounts, null, 2);
    for (const button of dialog.querySelectorAll('button')) {
        button.style.cssText = 'padding:9px 13px;border:1px solid #814ab7;border-radius:4px;font:14px Arial;cursor:pointer';
    }

    function showError(error) {
        output.style.color = '#b32323';
        output.textContent = error.message;
    }
    function invalidate() { preview = null; apply.disabled = true; output.textContent = 'Click Preview counts to validate the data.'; }
    function review() {
        invalidate();
        try {
            const vm = findMetagame(document);
            const rows = matchCounts(parseCounts(input.value), vm.heroesById);
            preview = { vm, rows, text: input.value };
            const total = rows.reduce((sum, row) => sum + row.count, 0);
            output.style.color = '#222';
            output.textContent = `${total} players across ${rows.length} heroes\n\n`
                + rows.map(row => `${String(row.count).padStart(3)}  ${vm.heroesById[row.hero].label}`).join('\n');
            apply.disabled = false;
            undo.disabled = !previous || previous.vm !== vm;
        } catch (error) { showError(error); }
    }

    input.addEventListener('input', invalidate);
    dialog.querySelector('input[type="file"]').addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            input.value = await file.text();
            review();
        } catch (error) { invalidate(); showError(error); }
    });
    dialog.querySelector('[data-action="preview"]').addEventListener('click', review);
    apply.addEventListener('click', async () => {
        try {
            const vm = findMetagame(document);
            if (!preview || preview.text !== input.value || preview.vm !== vm) throw new Error('Preview the data again before applying.');
            apply.disabled = true;
            previous = await applyCounts(vm, preview.rows);
            undo.disabled = false;
            output.textContent = 'Imported. Close this window to view the chart and use PurpleFox’s Export button. Undo is available here until the page is reloaded.';
            preview = null;
        } catch (error) { showError(error); }
    });
    undo.addEventListener('click', async () => {
        try {
            const vm = findMetagame(document);
            if (!previous || previous.vm !== vm) throw new Error('No previous chart is available on this page.');
            vm.$data.metagame = previous.rows.map(row => ({ ...row }));
            vm.usePercent = previous.usePercent;
            await vm.$nextTick();
            previous = null;
            undo.disabled = true;
            invalidate();
            output.textContent = 'Previous chart restored.';
        } catch (error) { showError(error); }
    });
    dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
    launch.addEventListener('click', () => { dialog.showModal(); review(); });
    document.body.append(launch, dialog);
    function updateVisibility() {
        const url = new URL(location.href);
        const active = url.pathname === '/stage/tools' && url.searchParams.get('tab') === 'metagame';
        launch.style.display = active ? 'block' : 'none';
        if (!active && dialog.open) dialog.close();
    }
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; updateVisibility(); });
    }).observe(document.querySelector('#app') || document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', updateVisibility);
    updateVisibility();
})();
