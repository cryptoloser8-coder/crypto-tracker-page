// app.js

// --- STAN GLOBALNY (musi być zadeklarowany na samej górze) ---
// Uwaga: te zmienne MUSZĄ być zadeklarowane przed jakimkolwiek wywołaniem
// unlockDashboard()/loadPortfolioData() poniżej — inaczej JS rzuci
// "ReferenceError: Cannot access ... before initialization" (TDZ dla let/const),
// bo kod niżej (savedToken -> unlockDashboard) wykonuje się już przy starcie skryptu.
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000; // co ile automatycznie sprawdzamy dane (ms)
let autoRefreshTimer = null;
let isRefreshing = false; // zabezpieczenie przed nakładającymi się requestami do portfolio-data.json
let isTriggering = false; // zabezpieczenie przed dwukrotnym uruchomieniem backendu naraz

// --- KONFIGURACJA WYZWALANIA BACKENDU (GitHub Actions workflow_dispatch) ---
// Token wpisywany na ekranie logowania MUSI być prawdziwym GitHub Personal Access
// Tokenem ze scope'ami "repo" + "workflow" (classic) — inaczej wywołania niżej się nie powiodą.
const BACKEND_REPO = 'cryptoloser8-coder/crypto-tracker'; // owner/repo prywatnego backendu
const BACKEND_WORKFLOW_FILE = 'update-portfolio.yml';
const BACKEND_BRANCH = 'main'; // zmień na 'master' (lub inną), jeśli backend używa innej domyślnej gałęzi
const POLL_INTERVAL_MS = 4000; // co ile sprawdzamy status runa w Actions
const MAX_WAIT_FOR_RUN_MS = 30 * 1000; // ile czekamy aż run w ogóle pojawi się na liście
const MAX_WAIT_FOR_COMPLETION_MS = 3 * 60 * 1000; // maksymalny czas czekania na zakończenie runa

// --- KONFIGURACJA PLIKU Z NADPISANIAMI (ukryte pozycje + ręcznie dodane + ledgery) ---
// Trzymamy to w publicznym repo frontendu, obok portfolio-data.json — ten sam
// token (Contents: Read and write) który uruchamia backend, zapisuje też ten plik.
const OVERRIDES_REPO = 'cryptoloser8-coder/crypto-tracker-page';
const OVERRIDES_PATH = 'overrides.json';
const OVERRIDES_BRANCH = 'main'; // zmień, jeśli Pages serwuje z innej gałęzi

// Dane ostatnio wczytane z plików — trzymane w pamięci, żeby renderDashboard()
// mogło przeliczać widok bez ponownego pobierania portfolio-data.json za każdym razem
let currentPortfolioData = null;
let currentOverrides = { hidden: [], manual: [], ledgers: {} };

// Sprawdzamy, czy token jest już zapamiętany w przeglądarce
const savedToken = localStorage.getItem('portfolio_auth_token');
if (savedToken) {
    unlockDashboard(savedToken);
}

document.getElementById('auth-btn').addEventListener('click', async () => {
    const authBtn = document.getElementById('auth-btn');
    const token = document.getElementById('token-input').value.trim();
    if (!token) {
        showError('Wpisz token!');
        return;
    }

    showError(''); // czyścimy poprzedni komunikat
    authBtn.disabled = true;
    authBtn.innerText = 'Sprawdzam token...';

    const check = await validateToken(token);

    authBtn.disabled = false;
    authBtn.innerText = 'Odblokuj';

    if (!check.ok) {
        showError(check.message);
        return;
    }

    unlockDashboard(token);
});

// Sprawdza czy token faktycznie ma dostęp do repo backendu, zanim wpuścimy na dashboard
async function validateToken(token) {
    try {
        const res = await fetch(`https://api.github.com/repos/${BACKEND_REPO}`, {
            headers: githubHeaders(token),
            cache: 'no-store'
        });
        if (res.status === 200) return { ok: true };
        if (res.status === 401) return { ok: false, message: 'Token nieprawidłowy lub wygasł.' };
        if (res.status === 403) return { ok: false, message: 'Token nie ma uprawnień do repo backendu (sprawdź scope "repo" + "workflow") albo przekroczono limit zapytań GitHub API.' };
        if (res.status === 404) return { ok: false, message: `Token nie ma dostępu do repo ${BACKEND_REPO} (albo zła nazwa repo).` };
        return { ok: false, message: `Nieoczekiwany błąd przy sprawdzaniu tokena (HTTP ${res.status}).` };
    } catch (e) {
        return { ok: false, message: `Błąd sieci przy sprawdzaniu tokena: ${e.message}` };
    }
}

function unlockDashboard(token) {
    localStorage.setItem('portfolio_auth_token', token);
    document.getElementById('auth-overlay').style.display = 'none';
    loadPortfolioData();
    startAutoRefresh();
}

// --- AUTO-ODŚWIEŻANIE ---
function startAutoRefresh() {
    if (autoRefreshTimer) return; // już działa, nie duplikujemy
    autoRefreshTimer = setInterval(loadPortfolioData, AUTO_REFRESH_INTERVAL_MS);
}

function showError(msg) {
    document.getElementById('auth-error').innerText = msg;
}

// --- WYZWALANIE BACKENDU PRZEZ GITHUB ACTIONS API ---

function githubHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function explainGithubError(status) {
    if (status === 401) return 'token nieprawidłowy lub wygasł.';
    if (status === 403) return 'brak uprawnień (sprawdź scope "repo" + "workflow") albo limit zapytań GitHub API.';
    if (status === 404) return 'nie znaleziono repo/workflow — sprawdź nazwę repo i plik workflow.';
    if (status === 422) return 'niepoprawna gałąź (ref) albo workflow ma wyłączony workflow_dispatch.';
    return `nieoczekiwany błąd (HTTP ${status}).`;
}

// Wyzwala workflow_dispatch w backendzie, czeka aż run się skończy, i dopiero wtedy
// odświeża dane na dashboardzie. To jest to, co robi kliknięcie "Odśwież dane".
async function triggerBackendRefresh() {
    const token = localStorage.getItem('portfolio_auth_token');
    if (!token) {
        setFetchStatus('Brak tokena — zaloguj się ponownie.', true);
        return;
    }

    const dispatchTimeMs = Date.now();

    // 1) Wywołujemy workflow_dispatch
    setFetchStatus('Uruchamiam backend...');
    let dispatchRes;
    try {
        dispatchRes = await fetch(
            `https://api.github.com/repos/${BACKEND_REPO}/actions/workflows/${BACKEND_WORKFLOW_FILE}/dispatches`,
            {
                method: 'POST',
                headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
                body: JSON.stringify({ ref: BACKEND_BRANCH })
            }
        );
    } catch (e) {
        setFetchStatus(`Błąd sieci przy uruchamianiu backendu: ${e.message}`, true);
        return;
    }

    // Sukces workflow_dispatch to zawsze HTTP 204 (bez treści) — GitHub nie zwraca run_id,
    // więc żeby śledzić status, musimy dopiero poniżej znaleźć nowo utworzony run na liście.
    if (dispatchRes.status !== 204) {
        setFetchStatus(`Nie udało się uruchomić backendu: ${explainGithubError(dispatchRes.status)}`, true);
        return;
    }

    // 2) Szukamy nowo utworzonego runa na liście (może się pojawić z kilkusekundowym opóźnieniem)
    setFetchStatus('Backend uruchomiony, czekam na start...');
    let run = null;
    const findDeadline = Date.now() + MAX_WAIT_FOR_RUN_MS;
    while (Date.now() < findDeadline && !run) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const runsRes = await fetch(
                `https://api.github.com/repos/${BACKEND_REPO}/actions/workflows/${BACKEND_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`,
                { headers: githubHeaders(token), cache: 'no-store' }
            );
            if (runsRes.ok) {
                const runsData = await runsRes.json();
                run = (runsData.workflow_runs || []).find(
                    r => new Date(r.created_at).getTime() >= dispatchTimeMs - 5000
                ) || null;
            }
        } catch (e) {
            // Pojedynczy błąd sieci podczas szukania runa — próbujemy dalej aż do deadline'u
        }
    }

    if (!run) {
        setFetchStatus('Backend uruchomiony, ale nie mogę potwierdzić statusu — sprawdź zakładkę Actions ręcznie.', true);
        return;
    }

    // 3) Czekamy aż run się skończy (status przechodzi queued -> in_progress -> completed)
    const waitDeadline = Date.now() + MAX_WAIT_FOR_COMPLETION_MS;
    while (run.status !== 'completed' && Date.now() < waitDeadline) {
        setFetchStatus(`Backend pracuje (${run.status})...`);
        await sleep(POLL_INTERVAL_MS);
        try {
            const runRes = await fetch(run.url, { headers: githubHeaders(token), cache: 'no-store' });
            if (runRes.ok) {
                run = await runRes.json();
            }
        } catch (e) {
            // Pojedynczy błąd sieci podczas odpytywania statusu — próbujemy dalej aż do deadline'u
        }
    }

    if (run.status !== 'completed') {
        setFetchStatus('Backend wciąż pracuje po przekroczeniu limitu czasu oczekiwania — sprawdź zakładkę Actions.', true);
        return;
    }

    if (run.conclusion !== 'success') {
        setFetchStatus(`Backend zakończył pracę z błędem (${run.conclusion}) — sprawdź logi w zakładce Actions.`, true);
        return;
    }

    // 4) Sukces — backend skończył liczyć i wypchnął nowy portfolio-data.json, pobieramy świeże dane
    setFetchStatus('Backend skończył, pobieram nowe dane...');
    await loadPortfolioData();
}

// Inicjalizacja wykresu Chart.js
const ctx = document.getElementById('performanceChart').getContext('2d');
const gradient = ctx.createLinearGradient(0, 0, 0, 200);
gradient.addColorStop(0, 'rgba(212, 175, 55, 0.4)');
gradient.addColorStop(1, 'rgba(212, 175, 55, 0.0)');

const performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['Start', 'Teraz'],
        datasets: [{
            data: [0, 0],
            borderColor: '#d4af37',
            borderWidth: 2,
            backgroundColor: gradient,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: '#d4af37'
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af' } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af' } }
        }
    }
});

// Pomocnicza funkcja do formatowania aktualnego czasu (HH:MM:SS)
function formatNow() {
    return new Date().toLocaleTimeString('pl-PL');
}

function setFetchStatus(text, isError = false) {
    const el = document.getElementById('fetch-status');
    if (!el) return;
    el.innerText = text;
    el.style.color = isError ? '#ef4444' : 'var(--text-muted)';
}

// --- POMOCNICZE: bezpieczne wstawianie tekstu do innerHTML ---
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

// --- KODOWANIE UTF-8 <-> BASE64 (wymagane przez GitHub Contents API) ---
function utf8ToBase64(str) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function base64ToUtf8(b64) {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

// Unikalny klucz identyfikujący konkretny wiersz w tabeli (token + portfel + sieć)
function assetKey(asset) {
    return `${asset.symbol}::${asset.walletName}::${asset.network}`;
}

// Łączy surowe dane z backendu z nadpisaniami użytkownika (ukryte + ręcznie dodane)
function getVisibleAssets() {
    const hiddenSet = new Set(currentOverrides.hidden || []);
    const real = (currentPortfolioData?.assets || []).filter(a => !hiddenSet.has(assetKey(a)));
    const manual = (currentOverrides.manual || []).map(m => ({ ...m, isManual: true }));
    return [...real, ...manual];
}

// --- LEDGERY (ręczne, nazwane listy transakcji - wpłata/wypłata/zakup/korekta) ---
// Ogólny mechanizm do salda, którego nie da się (albo nie do końca da się) policzyć
// automatycznie z chaina - np. saldo "w drodze" w FOMO. Struktura w overrides.json:
// { ledgers: { "<klucz>": { label: "FOMO", transactions: [{id, type, amountUsd, date, note}] } } }

function txTypeLabel(type) {
    switch (type) {
        case 'deposit': return 'Wpłata';
        case 'withdrawal': return 'Wypłata';
        case 'purchase': return 'Zakup';
        case 'correction': return 'Korekta';
        default: return type;
    }
}

// Saldo jednego ledgera: deposit (+), withdrawal/purchase (-), correction (znak wpisany przez użytkownika)
function getLedgerBalance(ledger) {
    return (ledger.transactions || []).reduce((sum, t) => {
        const amt = Number(t.amountUsd) || 0;
        if (t.type === 'deposit') return sum + amt;
        if (t.type === 'withdrawal' || t.type === 'purchase') return sum - amt;
        if (t.type === 'correction') return sum + amt;
        return sum;
    }, 0);
}

// Suma sald wszystkich ledgerów naraz - dolicza się do sumy portfela
function getLedgersTotal() {
    return Object.values(currentOverrides.ledgers || {}).reduce((sum, l) => sum + getLedgerBalance(l), 0);
}

function slugifyLedgerLabel(label) {
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return slug || `ledger-${Date.now()}`;
}

async function addLedgerTransaction(ledgerKey, label, tx) {
    if (!currentOverrides.ledgers[ledgerKey]) {
        currentOverrides.ledgers[ledgerKey] = { label: label || ledgerKey, transactions: [] };
    }
    currentOverrides.ledgers[ledgerKey].transactions.push({
        id: `tx-${Date.now()}`,
        type: tx.type,
        amountUsd: Number(tx.amountUsd) || 0,
        date: tx.date || new Date().toISOString().substring(0, 10),
        note: tx.note || ''
    });
    renderDashboard();
    scheduleSave();
}

async function updateLedgerTransaction(ledgerKey, txId, fields) {
    const ledger = currentOverrides.ledgers[ledgerKey];
    if (!ledger) return;
    const tx = (ledger.transactions || []).find(t => t.id === txId);
    if (!tx) return;

    tx.type = fields.type;
    tx.amountUsd = Number(fields.amountUsd) || 0;
    tx.date = fields.date || tx.date;
    tx.note = fields.note ?? tx.note;

    renderDashboard();
    scheduleSave();
}

async function removeLedgerTransaction(ledgerKey, txId) {
    const ledger = currentOverrides.ledgers[ledgerKey];
    if (!ledger) return;
    ledger.transactions = (ledger.transactions || []).filter(t => t.id !== txId);
    // Zostawiamy pusty ledger (nie kasujemy etykiety), na wypadek gdyby zaraz doszła kolejna transakcja
    renderDashboard();
    scheduleSave();
}

// Renderuje panel ledgerów: każdy jako blok z etykietą+saldem, i listą transakcji pod spodem
function renderLedgersPanel() {
    const container = document.getElementById('ledgers-list');
    if (!container) return;
    container.innerHTML = '';

    const ledgers = currentOverrides.ledgers || {};
    const keys = Object.keys(ledgers);

    if (keys.length === 0) {
        container.innerHTML = `<div class="muted-note">Brak ledgerów - dodaj transakcję, żeby utworzyć pierwszy.</div>`;
        return;
    }

    keys.forEach(key => {
        const ledger = ledgers[key];
        const balance = getLedgerBalance(ledger);

        const block = document.createElement('div');
        block.className = 'hidden-item-row';
        block.style.flexDirection = 'column';
        block.style.alignItems = 'stretch';
        block.style.gap = '6px';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.innerHTML = `<strong>${escapeHtml(ledger.label || key)}</strong><span>$${balance.toFixed(2)}</span>`;
        block.appendChild(header);

        const sortedTxs = (ledger.transactions || [])
            .slice()
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

        if (sortedTxs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'muted-note';
            empty.innerText = 'Brak transakcji w tym ledgerze.';
            block.appendChild(empty);
        }

        sortedTxs.forEach(tx => {
            const sign = tx.type === 'deposit' ? '+' : (tx.type === 'correction' ? (Number(tx.amountUsd) >= 0 ? '+' : '−') : '−');
            const row = document.createElement('div');
            row.className = 'hidden-item-row';
            row.innerHTML = `
                <span>${escapeHtml(tx.date || '')} — ${escapeHtml(txTypeLabel(tx.type))} — ${sign}$${Math.abs(Number(tx.amountUsd) || 0).toFixed(2)}${tx.note ? ' — ' + escapeHtml(tx.note) : ''}</span>
                <span>
                    <button class="row-action-btn" data-action="edit-ledger-tx" data-ledger="${escapeHtml(key)}" data-id="${escapeHtml(tx.id)}">Edytuj</button>
                    <button class="row-action-btn" data-action="remove-ledger-tx" data-ledger="${escapeHtml(key)}" data-id="${escapeHtml(tx.id)}">Usuń</button>
                </span>
            `;
            block.appendChild(row);
        });

        container.appendChild(block);
    });
}

// Renderuje karty sum, tabelę assetów i panel ukrytych pozycji na podstawie
// currentPortfolioData + currentOverrides. Wywoływane po każdym załadowaniu
// danych ORAZ po każdej zmianie (ukrycie/przywrócenie/dodanie ręczne/zmiana ledgera).
function renderDashboard() {
    const visible = getVisibleAssets();

    // Suma liczona z widocznych assetów + sald wszystkich ledgerów (np. FOMO "w drodze")
    const assetsTotal = visible.reduce((sum, a) => sum + (Number(a.valueUsd) || 0), 0);
    const total = assetsTotal + getLedgersTotal();
    const totalFormatted = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('total-portfolio-value').innerText = totalFormatted;
    document.getElementById('total-wealth').innerText = totalFormatted;

    const tbody = document.getElementById('assets-table-body');
    tbody.innerHTML = '';

    if (visible.length > 0) {
        visible.forEach(asset => {
            const row = document.createElement('tr');
            const balance = Number(asset.balance) || 0;
            const valueUsd = Number(asset.valueUsd) || 0;

            const actionCell = asset.isManual
                ? `<button class="row-action-btn" data-action="remove-manual" data-id="${escapeHtml(asset.id)}">Usuń</button>`
                : `<button class="row-action-btn" data-action="hide" data-key="${escapeHtml(assetKey(asset))}">Ukryj</button>`;

            row.innerHTML = `
                <td><strong>${escapeHtml(asset.symbol)}</strong>${asset.isManual ? ' <span class="manual-badge">ręcznie</span>' : ''}</td>
                <td>${escapeHtml(asset.walletName)} (${escapeHtml(asset.network)})</td>
                <td>${balance.toFixed(4)}</td>
                <td>$${valueUsd.toFixed(2)}</td>
                <td>${actionCell}</td>
            `;
            tbody.appendChild(row);
        });
    } else {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Brak aktywnych aktywów</td></tr>`;
    }

    renderHiddenPanel();
    renderLedgersPanel();
}

// Renderuje listę ukrytych pozycji z przyciskiem "Przywróć" przy każdej
function renderHiddenPanel() {
    const hidden = currentOverrides.hidden || [];
    const countEl = document.getElementById('hidden-count');
    if (countEl) countEl.innerText = hidden.length;

    const listEl = document.getElementById('hidden-assets-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (hidden.length === 0) {
        listEl.innerHTML = `<div class="muted-note">Brak ukrytych pozycji.</div>`;
        return;
    }

    hidden.forEach(key => {
        const [symbol, walletName, network] = key.split('::');
        const div = document.createElement('div');
        div.className = 'hidden-item-row';
        div.innerHTML = `
            <span>${escapeHtml(symbol)} — ${escapeHtml(walletName)} (${escapeHtml(network)})</span>
            <button class="row-action-btn" data-action="restore" data-key="${escapeHtml(key)}">Przywróć</button>
        `;
        listEl.appendChild(div);
    });
}

// --- ZAPIS NADPISAŃ (overrides.json) PRZEZ GITHUB CONTENTS API ---
// Zapisy są KOLEJKOWANE: jeśli kilka akcji (np. szybkie klikanie "Ukryj") zdarzy się
// zanim poprzedni zapis się skończy, nie lecą równoległe requesty (co powodowało 409
// Conflict — każdy brał ten sam "stary" sha pliku). Zamiast tego czekają w kolejce,
// a każda kolejna iteracja i tak zapisuje AKTUALNY stan currentOverrides, więc żadna
// zmiana nie ginie, tylko liczba realnych zapisów do repo jest mniejsza.
let saveQueued = false;
let saveInFlight = false;

function scheduleSave() {
    saveQueued = true;
    processSaveQueue();
}

async function processSaveQueue() {
    if (saveInFlight) return; // zapis już trwa — ten call doczeka się przez flagę saveQueued
    saveInFlight = true;
    while (saveQueued) {
        saveQueued = false;
        await saveOverridesOnce();
    }
    saveInFlight = false;
}

async function saveOverridesOnce(retriesLeft = 2) {
    const token = localStorage.getItem('portfolio_auth_token');
    if (!token) {
        setFetchStatus('Brak tokena — zaloguj się ponownie, żeby zapisać zmiany.', true);
        return false;
    }

    setFetchStatus('Zapisuję zmiany...');

    try {
        // 1) Pobieramy AKTUALNY sha pliku tuż przed zapisem (cache: 'no-store' wymusza
        // pominięcie cache przeglądarki — bez tego GET potrafił oddać zcache'owaną
        // odpowiedź 404 sprzed utworzenia pliku, co prowadziło do PUT bez sha i 409 Conflict)
        let sha;
        const getRes = await fetch(
            `https://api.github.com/repos/${OVERRIDES_REPO}/contents/${OVERRIDES_PATH}?ref=${OVERRIDES_BRANCH}`,
            { headers: githubHeaders(token), cache: 'no-store' }
        );
        if (getRes.status === 200) {
            sha = (await getRes.json()).sha;
        } else if (getRes.status !== 404) {
            // 404 = plik jeszcze nie istnieje, tworzymy go od zera — to nie błąd
            setFetchStatus(`Nie udało się odczytać overrides.json: ${explainGithubError(getRes.status)}`, true);
            return false;
        }

        // 2) Zapisujemy nową wersję (currentOverrides bierzemy w momencie zapisu,
        // więc zawsze leci najświeższy stan, nawet jeśli kolejka czekała chwilę)
        const contentStr = JSON.stringify(currentOverrides, null, 2);
        const putRes = await fetch(
            `https://api.github.com/repos/${OVERRIDES_REPO}/contents/${OVERRIDES_PATH}`,
            {
                method: 'PUT',
                headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
                cache: 'no-store',
                body: JSON.stringify({
                    message: 'Aktualizacja overrides.json (ukryte/ręczne pozycje/ledgery)',
                    content: utf8ToBase64(contentStr),
                    branch: OVERRIDES_BRANCH,
                    ...(sha ? { sha } : {})
                })
            }
        );

        if (putRes.status === 409 && retriesLeft > 0) {
            // Ktoś (albo inna karta/urządzenie) zmienił plik dosłownie w tej samej chwili —
            // pobieramy świeży sha i próbujemy jeszcze raz, zamiast od razu zgłaszać błąd
            return saveOverridesOnce(retriesLeft - 1);
        }

        if (!putRes.ok) {
            setFetchStatus(`Nie udało się zapisać zmian: ${explainGithubError(putRes.status)}`, true);
            return false;
        }

        setFetchStatus(`Zapisano zmiany: ${formatNow()} ✓`);
        return true;
    } catch (e) {
        setFetchStatus(`Błąd sieci przy zapisie zmian: ${e.message}`, true);
        return false;
    }
}

// --- AKCJE UŻYTKOWNIKA: ukryj / przywróć / dodaj ręcznie / usuń ręczny wpis ---
// Każda akcja od razu odświeża widok (optymistycznie), a potem zapisuje w tle do repo

async function hideAsset(key) {
    if (!currentOverrides.hidden.includes(key)) currentOverrides.hidden.push(key);
    renderDashboard();
    scheduleSave();
}

async function restoreAsset(key) {
    currentOverrides.hidden = currentOverrides.hidden.filter(k => k !== key);
    renderDashboard();
    scheduleSave();
}

async function removeManualAsset(id) {
    currentOverrides.manual = currentOverrides.manual.filter(m => m.id !== id);
    renderDashboard();
    scheduleSave();
}

async function addManualAsset({ symbol, walletName, network, balance, valueUsd }) {
    currentOverrides.manual.push({
        id: `manual-${Date.now()}`,
        symbol: symbol || '???',
        walletName: walletName || 'Ręcznie',
        network: network || 'manual',
        balance: Number(balance) || 0,
        valueUsd: Number(valueUsd) || 0
    });
    renderDashboard();
    scheduleSave();
}

// Obsługa kliknięć w tabeli assetów (przyciski "Ukryj" / "Usuń") — delegacja zdarzeń,
// żeby nie podpinać osobnego listenera do każdego wiersza przy każdym renderze
document.getElementById('assets-table-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'hide') hideAsset(btn.dataset.key);
    if (btn.dataset.action === 'remove-manual') removeManualAsset(btn.dataset.id);
});

// Obsługa kliknięć w panelu ukrytych pozycji (przycisk "Przywróć")
document.getElementById('hidden-assets-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="restore"]');
    if (!btn) return;
    restoreAsset(btn.dataset.key);
});

// Rozwijanie/zwijanie panelu ukrytych pozycji
document.getElementById('toggle-hidden-btn').addEventListener('click', () => {
    const list = document.getElementById('hidden-assets-list');
    list.style.display = list.style.display === 'none' ? 'flex' : 'none';
});

// Pokazywanie/ukrywanie formularza ręcznego dodawania
document.getElementById('add-manual-btn').addEventListener('click', () => {
    const form = document.getElementById('add-manual-form');
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('manual-cancel-btn').addEventListener('click', () => {
    document.getElementById('add-manual-form').style.display = 'none';
    document.getElementById('manual-form-error').innerText = '';
});

document.getElementById('manual-submit-btn').addEventListener('click', async () => {
    const symbol = document.getElementById('manual-symbol').value.trim();
    const walletName = document.getElementById('manual-wallet').value.trim();
    const network = document.getElementById('manual-network').value.trim();
    const balance = document.getElementById('manual-balance').value.trim();
    const valueUsd = document.getElementById('manual-value').value.trim();
    const errorEl = document.getElementById('manual-form-error');

    if (!symbol || !valueUsd) {
        errorEl.innerText = 'Podaj przynajmniej Symbol i Wartość USD.';
        return;
    }
    errorEl.innerText = '';

    await addManualAsset({ symbol, walletName, network, balance, valueUsd });

    // Czyścimy i chowamy formularz po udanym dodaniu
    document.getElementById('manual-symbol').value = '';
    document.getElementById('manual-wallet').value = '';
    document.getElementById('manual-network').value = '';
    document.getElementById('manual-balance').value = '';
    document.getElementById('manual-value').value = '';
    document.getElementById('add-manual-form').style.display = 'none';
});

// --- FORMULARZ "+ Dodaj transakcję" (ledgery) ---
// Ten sam formularz służy do dodawania NOWEJ transakcji i do edycji ISTNIEJĄCEJ
// (klik "Edytuj" w panelu ledgerów wypełnia pola i przełącza tryb - patrz niżej).
let editingLedgerKey = null;
let editingTxId = null;

function toggleNewLedgerLabelVisibility() {
    const isNew = document.getElementById('ledger-select').value === '__new__';
    document.getElementById('ledger-new-label').style.display = isNew ? 'block' : 'none';
}

// Wypełnia dropdown ledgerów aktualną listą + opcją "+ Nowy ledger..."
function populateLedgerSelect(preselectKey) {
    const select = document.getElementById('ledger-select');
    const keys = Object.keys(currentOverrides.ledgers || {});

    select.innerHTML = '';
    keys.forEach(key => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = currentOverrides.ledgers[key].label || key;
        select.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ Nowy ledger...';
    select.appendChild(newOpt);

    select.value = (preselectKey && keys.includes(preselectKey)) ? preselectKey : (keys[0] || '__new__');
    toggleNewLedgerLabelVisibility();
}

function resetLedgerForm() {
    document.getElementById('ledger-tx-type').value = 'deposit';
    document.getElementById('ledger-tx-amount').value = '';
    document.getElementById('ledger-tx-date').value = '';
    document.getElementById('ledger-tx-note').value = '';
    document.getElementById('ledger-new-label').value = '';
    document.getElementById('ledger-form-error').innerText = '';
    document.getElementById('ledger-select').disabled = false;
    document.getElementById('ledger-tx-submit-btn').innerText = 'Dodaj';
    editingLedgerKey = null;
    editingTxId = null;
}

document.getElementById('add-ledger-tx-btn').addEventListener('click', () => {
    const form = document.getElementById('add-ledger-form');
    const opening = form.style.display === 'none';
    if (opening) {
        resetLedgerForm();
        populateLedgerSelect();
    }
    form.style.display = opening ? 'flex' : 'none';
});

document.getElementById('ledger-select').addEventListener('change', toggleNewLedgerLabelVisibility);

document.getElementById('ledger-tx-cancel-btn').addEventListener('click', () => {
    document.getElementById('add-ledger-form').style.display = 'none';
    resetLedgerForm();
});

document.getElementById('ledger-tx-submit-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('ledger-form-error');
    const type = document.getElementById('ledger-tx-type').value;
    const amountUsdRaw = document.getElementById('ledger-tx-amount').value.trim();
    const date = document.getElementById('ledger-tx-date').value;
    const note = document.getElementById('ledger-tx-note').value.trim();

    if (!amountUsdRaw || isNaN(Number(amountUsdRaw))) {
        errorEl.innerText = 'Podaj poprawną kwotę USD.';
        return;
    }
    errorEl.innerText = '';

    if (editingLedgerKey && editingTxId) {
        await updateLedgerTransaction(editingLedgerKey, editingTxId, { type, amountUsd: amountUsdRaw, date, note });
    } else {
        const select = document.getElementById('ledger-select');
        let ledgerKey = select.value;
        let label = ledgerKey;

        if (ledgerKey === '__new__') {
            label = document.getElementById('ledger-new-label').value.trim();
            if (!label) {
                errorEl.innerText = 'Podaj nazwę nowego ledgera.';
                return;
            }
            ledgerKey = slugifyLedgerLabel(label);
        } else {
            label = currentOverrides.ledgers[ledgerKey]?.label || ledgerKey;
        }

        await addLedgerTransaction(ledgerKey, label, { type, amountUsd: amountUsdRaw, date, note });
    }

    document.getElementById('add-ledger-form').style.display = 'none';
    resetLedgerForm();
});

// Delegacja kliknięć w panelu ledgerów (przyciski "Edytuj" / "Usuń" przy każdej transakcji)
document.getElementById('ledgers-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const ledgerKey = btn.dataset.ledger;
    const txId = btn.dataset.id;

    if (btn.dataset.action === 'remove-ledger-tx') {
        removeLedgerTransaction(ledgerKey, txId);
        return;
    }

    if (btn.dataset.action === 'edit-ledger-tx') {
        const ledger = currentOverrides.ledgers[ledgerKey];
        const tx = ledger && (ledger.transactions || []).find(t => t.id === txId);
        if (!tx) return;

        editingLedgerKey = ledgerKey;
        editingTxId = txId;

        populateLedgerSelect(ledgerKey);
        document.getElementById('ledger-select').disabled = true; // przy edycji nie przenosimy transakcji między ledgerami

        document.getElementById('ledger-tx-type').value = tx.type;
        document.getElementById('ledger-tx-amount').value = tx.amountUsd;
        document.getElementById('ledger-tx-date').value = tx.date || '';
        document.getElementById('ledger-tx-note').value = tx.note || '';
        document.getElementById('ledger-tx-submit-btn').innerText = 'Zapisz zmiany';
        document.getElementById('ledger-form-error').innerText = '';

        document.getElementById('add-ledger-form').style.display = 'flex';
    }
});

// Główna funkcja pobierająca dane i zlecająca ich wyrenderowanie
async function loadPortfolioData() {
    // Nie odpalamy drugiego fetcha, jeśli poprzedni jeszcze trwa
    // (może się zdarzyć gdy auto-refresh nałoży się na ręczne kliknięcie)
    if (isRefreshing) return;
    isRefreshing = true;

    try {
        // Dodajemy parametr czasu (?t=...), aby przeglądarka nie pobierała starej wersji z pamięci podręcznej (cache)
        const response = await fetch(`portfolio-data.json?t=${Date.now()}`);
        if (!response.ok) throw new Error(`Brak pliku danych (HTTP ${response.status})`);
        currentPortfolioData = await response.json();

        // overrides.json może jeszcze nie istnieć (zanim cokolwiek ukryjesz/dodasz ręcznie)
        // — brak tego pliku to normalny stan, nie błąd
        try {
            const overridesRes = await fetch(`overrides.json?t=${Date.now()}`);
            currentOverrides = overridesRes.ok ? await overridesRes.json() : { hidden: [], manual: [], ledgers: {} };
        } catch (e) {
            currentOverrides = { hidden: [], manual: [], ledgers: {} };
        }
        if (!Array.isArray(currentOverrides.hidden)) currentOverrides.hidden = [];
        if (!Array.isArray(currentOverrides.manual)) currentOverrides.manual = [];
        if (!currentOverrides.ledgers || typeof currentOverrides.ledgers !== 'object') currentOverrides.ledgers = {};

        document.getElementById('last-update').innerText = `Ostatnia aktualizacja danych: ${currentPortfolioData.timestamp}`;

        renderDashboard();

        // Sukces — pokazujemy kiedy strona faktycznie sprawdziła plik
        // (to jest INNA informacja niż "Ostatnia aktualizacja danych" powyżej —
        // ta pokazuje kiedy backend wygenerował dane, ta poniżej kiedy strona to sprawdziła)
        setFetchStatus(`Ostatnie sprawdzenie: ${formatNow()} ✓`);

    } catch (error) {
        console.log("Błąd podczas ładowania danych:", error);
        setFetchStatus(`Błąd odświeżania (${formatNow()}): ${error.message}. Poprzednie dane wciąż widoczne.`, true);
    } finally {
        isRefreshing = false;
    }
}

// OBSŁUGA PRZYCISKU ODŚWIEŻANIA NA STRONIE
// Kliknięcie realnie uruchamia backend (workflow_dispatch) i czeka na wynik —
// to nie jest tylko ponowne odczytanie tego samego pliku.
const refreshBtn = document.getElementById('refresh-btn');
if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
        if (isTriggering) return; // ignorujemy klik, gdy backend już się uruchamia/pracuje
        isTriggering = true;
        refreshBtn.disabled = true;
        refreshBtn.innerText = 'Odświeżanie...';
        try {
            await triggerBackendRefresh();
        } finally {
            isTriggering = false;
            refreshBtn.disabled = false;
            refreshBtn.innerText = 'Odśwież dane';
        }
    });
}
