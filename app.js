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
            headers: githubHeaders(token)
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
                { headers: githubHeaders(token) }
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
            const runRes = await fetch(run.url, { headers: githubHeaders(token) });
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

// Główna funkcja pobierająca i renderująca dane portfela
async function loadPortfolioData() {
    // Nie odpalamy drugiego fetcha, jeśli poprzedni jeszcze trwa
    // (może się zdarzyć gdy auto-refresh nałoży się na ręczne kliknięcie)
    if (isRefreshing) return;
    isRefreshing = true;

    try {
        // Dodajemy parametr czasu (?t=...), aby przeglądarka nie pobierała starej wersji z pamięci podręcznej (cache)
        const response = await fetch(`portfolio-data.json?t=${new Date().getTime()}`);
        if (!response.ok) throw new Error(`Brak pliku danych (HTTP ${response.status})`);

        const data = await response.json();

        document.getElementById('total-portfolio-value').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('total-wealth').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('last-update').innerText = `Ostatnia aktualizacja danych: ${data.timestamp}`;

        const tbody = document.getElementById('assets-table-body');
        tbody.innerHTML = '';

        if (data.assets && data.assets.length > 0) {
            data.assets.forEach(asset => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><strong>${asset.symbol}</strong></td>
                    <td>${asset.walletName} (${asset.network})</td>
                    <td>${asset.balance.toFixed(4)}</td>
                    <td>$${asset.valueUsd.toFixed(2)}</td>
                `;
                tbody.appendChild(row);
            });
        } else {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Brak aktywnych aktywów</td></tr>`;
        }

        // Sukces — pokazujemy kiedy strona faktycznie sprawdziła plik
        // (to jest INNA informacja niż "Ostatnia aktualizacja danych" powyżej —
        // ta pokazuje kiedy backend wygenerował dane, ta poniżej kiedy strona to sprawdziła)
        setFetchStatus(`Ostatnie sprawdzenie: ${formatNow()} ✓`);

    } catch (error) {
        console.log("Błąd podczas ładowania portfolio-data.json:", error);
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
