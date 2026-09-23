// app.js

// --- STAN GLOBALNY (musi być zadeklarowany na samej górze) ---
// Uwaga: te zmienne MUSZĄ być zadeklarowane przed jakimkolwiek wywołaniem
// unlockDashboard()/loadPortfolioData() poniżej — inaczej JS rzuci
// "ReferenceError: Cannot access ... before initialization" (TDZ dla let/const),
// bo kod niżej (savedToken -> unlockDashboard) wykonuje się już przy starcie skryptu.
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000; // co ile automatycznie sprawdzamy dane (ms)
let autoRefreshTimer = null;
let isRefreshing = false; // zabezpieczenie przed nakładającymi się requestami do portfolio-data.json

// --- KONFIGURACJA REPO FRONTENDU ---
// Backend (liczenie portfolio) żyje teraz WYŁĄCZNIE na Orange Pi (cron co 5 min,
// patrz run-portfolio-update.sh) - nie ma już żadnego repo GitHub Actions do
// wyzwalania stąd. Jedyne repo, z którym łączy się teraz strona, to to poniżej:
// publiczne repo frontendu, źródło plików danych i cel zapisu nadpisań.
const OVERRIDES_REPO = 'cryptoloser8-coder/crypto-tracker-page';
const OVERRIDES_PATH = 'overrides.json';
const OVERRIDES_BRANCH = 'main'; // zmień, jeśli Pages serwuje z innej gałęzi

// Dane ostatnio wczytane z plików — trzymane w pamięci, żeby renderDashboard()
// mogło przeliczać widok bez ponownego pobierania portfolio-data.json za każdym razem
let currentPortfolioData = null;
let currentOverrides = { hidden: [], manual: [], ledgers: {}, costBasis: {}, priceOverrides: {} };

// Historia wartości portfela (dopisywana przez backend co 15 min - patrz
// src/storage/appendHistory.js). Surowa suma z backendu (assets), BEZ ręcznych
// nadpisań z overrides.json (ukryte/dodane pozycje, ledgery) - może się więc
// nieznacznie różnić od aktualnie wyświetlanej sumy portfela na dashboardzie.
let currentPortfolioHistory = [];
// Suma faktycznie wyświetlona na dashboardzie (assets widoczne + ledgery) -
// ustawiana w renderDashboard(), używana do liczenia % wzrostu względem historii.
let lastComputedTotal = 0;

// --- TRYB PRYWATNY (ukrycie kwot, procenty zostają) ---
// Pamiętany w przeglądarce. Ukrywa wszystko, co zdradza wielkość portfela: sumy,
// wartości USD, ilości tokenów, kwoty zysku/straty, salda ledgerów i oś Y wykresu.
// Procenty, ceny jednostkowe i daty zostają widoczne.
let privacyMode = localStorage.getItem('privacy_mode') === '1';
const PRIVACY_MASK = '••••';

// Zwraca podany (już sformatowany) tekst albo maskę, jeśli tryb prywatny jest włączony
function money(formatted) {
    return privacyMode ? PRIVACY_MASK : formatted;
}

// --- SORTOWANIE I SZUKAJKA (tabela assetów) ---
let sortColumn = 'valueUsd';
let sortDirection = 'desc';

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

// Sprawdza czy token faktycznie ma dostęp DO ZAPISU w repo frontendu (potrzebny
// do zapisywania overrides.json), zanim wpuścimy na dashboard
async function validateToken(token) {
    try {
        const res = await fetch(`https://api.github.com/repos/${OVERRIDES_REPO}`, {
            headers: githubHeaders(token),
            cache: 'no-store'
        });
        if (res.status === 200) {
            const data = await res.json();
            // GitHub zwraca permissions.push=false jeśli token widzi repo, ale nie
            // może do niego zapisywać (np. tylko uprawnienie Contents: Read) -
            // złapiemy to tutaj zamiast dopiero przy pierwszej próbie zapisu
            if (data.permissions && data.permissions.push === false) {
                return { ok: false, message: 'Token ma tylko dostęp do odczytu tego repo - potrzebne uprawnienie "Contents: Read and write".' };
            }
            return { ok: true };
        }
        if (res.status === 401) return { ok: false, message: 'Token nieprawidłowy lub wygasł.' };
        if (res.status === 403) return { ok: false, message: 'Token nie ma uprawnień do repo (sprawdź scope "Contents: Read and write") albo przekroczono limit zapytań GitHub API.' };
        if (res.status === 404) return { ok: false, message: `Token nie ma dostępu do repo ${OVERRIDES_REPO} (albo zła nazwa repo).` };
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

// --- GITHUB API (nagłówki + opis błędów) ---

function githubHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

function explainGithubError(status) {
    if (status === 401) return 'token nieprawidłowy lub wygasł.';
    if (status === 403) return 'brak uprawnień (sprawdź scope "Contents: Read and write") albo limit zapytań GitHub API.';
    if (status === 404) return 'nie znaleziono repo — sprawdź nazwę repo.';
    if (status === 422) return 'niepoprawna gałąź (ref).';
    return `nieoczekiwany błąd (HTTP ${status}).`;
}

// Backend liczy portfolio samodzielnie co 5 min na Orange Pi (cron, patrz
// run-portfolio-update.sh) - strona niczego nie wyzwala, tylko co 60s sama
// pobiera aktualne pliki (auto-refresh, patrz startAutoRefresh()).

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
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: (item) => money(`$${Number(item.raw).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
                }
            },
            // Przybliżanie kółkiem myszy/gestem pinch + przesuwanie przeciągnięciem
            // (chartjs-plugin-zoom, patrz <script> w index.html) - działa niezależnie
            // od przełącznika zakresu czasu, każda zmiana zakresu resetuje zoom.
            zoom: {
                pan: { enabled: true, mode: 'x' },
                zoom: {
                    wheel: { enabled: true },
                    pinch: { enabled: true },
                    mode: 'x'
                },
                limits: { x: { minRange: 2 } }
            }
        },
        scales: {
            x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af', autoSkip: true, maxTicksLimit: 10, maxRotation: 0 } },
            y: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: {
                    color: '#9ca3af',
                    callback: (value) => money(Number(value).toLocaleString('en-US'))
                }
            }
        }
    }
});

// --- ASSET ALLOCATION (donut) --- wartość portfela podzielona per portfel (wallet).
// Kolory cyklicznie z tej palety (odcienie złota/grafitu, spójne z resztą motywu),
// gdyby portfeli było więcej niż kolorów w palecie.
const ALLOCATION_PALETTE = ['#d4af37', '#8892b0', '#e8d9b5', '#5b6472', '#b08d57', '#3a3f4b'];

const allocationCtx = document.getElementById('allocationChart').getContext('2d');
const allocationChart = new Chart(allocationCtx, {
    type: 'doughnut',
    data: {
        labels: [],
        datasets: [{
            data: [],
            backgroundColor: [],
            borderColor: '#07070a',
            borderWidth: 2
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '72%',
        plugins: {
            legend: { display: false }, // własny legend renderujemy obok (#allocation-legend)
            tooltip: {
                callbacks: {
                    label: (item) => `${item.label}: ${money(`$${Number(item.raw).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}`
                }
            }
        }
    }
});

// Podmienia dane wykresu donut + renderuje legendę obok niego (kropka + nazwa + %)
// na podstawie grup portfeli (walletName -> subtotal), niezależnie od filtra szukajki -
// alokacja ma pokazywać cały widoczny portfel, nie tylko przefiltrowany wycinek.
function updateAllocationChart(groups) {
    const legendEl = document.getElementById('allocation-legend');
    const total = groups.reduce((sum, g) => sum + g.subtotal, 0);

    if (!groups.length || total <= 0) {
        allocationChart.data.labels = [];
        allocationChart.data.datasets[0].data = [];
        allocationChart.data.datasets[0].backgroundColor = [];
        allocationChart.update();
        if (legendEl) legendEl.innerHTML = `<div class="muted-note">Brak danych do alokacji.</div>`;
        return;
    }

    const colors = groups.map((_, i) => ALLOCATION_PALETTE[i % ALLOCATION_PALETTE.length]);

    allocationChart.data.labels = groups.map(g => g.walletName);
    allocationChart.data.datasets[0].data = groups.map(g => g.subtotal);
    allocationChart.data.datasets[0].backgroundColor = colors;
    allocationChart.update();

    if (legendEl) {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const cols = 'grid-template-columns: minmax(130px, 1.4fr) 60px 110px repeat(5, 72px) 110px; gap: 12px; align-items: center;';
        const header = `
            <div class="allocation-legend-row muted-note" style="display: grid; ${cols} font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
                <span>Portfel</span><span>Udział</span><span>Wartość</span><span>24h</span><span>7D</span><span>30D</span><span>90D</span><span>Całość</span><span>Trend 24h</span>
            </div>`;
        const rows = groups.map((g, i) => {
            const pct = (g.subtotal / total) * 100;
            const series = getWalletSeries(g.walletName);
            return `
                <div class="allocation-legend-row" style="display: grid; ${cols}">
                    <span class="allocation-legend-label">
                        <span class="allocation-legend-dot" style="background:${colors[i]}"></span>
                        <span class="allocation-legend-name">${escapeHtml(g.walletName)}</span>
                    </span>
                    <span class="allocation-legend-pct">${pct.toFixed(1)}%</span>
                    <span>${money(`$${g.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</span>
                    <span>${formatWalletChange(walletChange(series, DAY_MS))}</span>
                    <span>${formatWalletChange(walletChange(series, 7 * DAY_MS))}</span>
                    <span>${formatWalletChange(walletChange(series, 30 * DAY_MS))}</span>
                    <span>${formatWalletChange(walletChange(series, 90 * DAY_MS))}</span>
                    <span>${formatWalletChange(walletChange(series, Infinity))}</span>
                    <span>${walletSparkline(series)}</span>
                </div>`;
        }).join('');
        legendEl.innerHTML = `<div style="overflow-x: auto;"><div style="min-width: 860px; display: flex; flex-direction: column; gap: 6px;">${header}${rows}</div></div>`;
    }
}

// --- WYNIKI POSZCZEGOLNYCH PORTFELI (kolumny 24h / 7D / trend w legendzie alokacji) ---
// Liczone z historii per portfel (pole "w" w punktach portfolio-history.json, zapisywane
// przez backend od momentu wgrania nowego appendHistory.js - starsze punkty go nie maja,
// wiec kolumny zapelnia sie same, gdy zbierze sie 24h / 7 dni danych). Zmiana liczona
// z surowych sum backendu (bez ukrytych/recznych pozycji), zeby porownywac to samo z tym samym.
function getWalletSeries(walletName) {
    return (currentPortfolioHistory || [])
        .filter(p => p.w && typeof p.w[walletName] === 'number')
        .map(p => ({ ms: parseHistoryTimestamp(p.t), v: p.w[walletName] }))
        .filter(pt => !isNaN(pt.ms))
        .sort((a, b) => a.ms - b.ms);
}

// Zmiana wzgledem ostatniego punktu starszego niz `lookbackMs` od najnowszego odczytu
function walletChange(series, lookbackMs) {
    if (series.length < 2) return null;
    const latest = series[series.length - 1];
    const target = latest.ms - lookbackMs;
    // lookbackMs = Infinity -> "Całość": liczymy od najstarszego dostępnego punktu
    let ref = lookbackMs === Infinity ? series[0] : null;
    for (const pt of series) {
        if (pt.ms <= target) ref = pt;
        else break;
    }
    if (!ref || ref.v <= 0) return null;
    const usd = latest.v - ref.v;
    return { usd, pct: (usd / ref.v) * 100 };
}

function formatWalletChange(change) {
    if (!change) return '<span class="muted-note" title="Za mało historii dla tego portfela">—</span>';
    const sign = change.usd >= 0 ? '+' : '';
    const cls = change.usd >= 0 ? 'pnl-pos' : 'pnl-neg';
    const title = privacyMode ? '' : ` title="${sign}$${change.usd.toFixed(2)}"`;
    return `<span class="${cls}"${title}>${sign}${change.pct.toFixed(1)}%</span>`;
}

// Mini-wykres ostatnich 24h (1 punkt na godzine) jako inline SVG
function walletSparkline(series) {
    if (series.length < 2) return '<span class="muted-note">—</span>';
    const latestMs = series[series.length - 1].ms;
    const hourly = new Map();
    series.filter(pt => pt.ms >= latestMs - 24 * 60 * 60 * 1000)
        .forEach(pt => hourly.set(Math.floor(pt.ms / 3600000), pt.v));
    hourly.set('last', series[series.length - 1].v); // zawsze konczymy na najswiezszym odczycie
    const values = Array.from(hourly.values());
    if (values.length < 2) return '<span class="muted-note">—</span>';

    const w = 100, h = 26, pad = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((v, i) => {
        const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
        const y = h - pad - ((v - min) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const first = values[0], last = values[values.length - 1];
    const color = last > first ? '#4ade80' : (last < first ? '#f85149' : '#d4af37');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display: block;"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Pomocnicza funkcja do formatowania aktualnego czasu (HH:MM:SS)
function formatNow() {
    return new Date().toLocaleTimeString('pl-PL');
}

// --- HISTORIA WARTOŚCI PORTFELA (wykres "Portfolio Performance" + "% wzrostu") ---
// portfolio-history.json to tablica punktów {t: "YYYY-MM-DD HH:MM:SS" (UTC), v: totalUsd},
// dopisywana przez backend przy każdym uruchomieniu workflow (co ~15 min).

const HISTORY_CHART_MAX_POINTS = 150; // downsampling, żeby wykres nie rysował tysięcy punktów (zoom i tak pozwala dojrzeć szczegóły)
const GROWTH_LOOKBACK_MS = 24 * 60 * 60 * 1000; // "wzrost w stosunku do..." liczony względem ~24h wstecz

// Aktualnie wybrany zakres czasu na wykresie Performance (dni wstecz; 0 = całość) -
// zmieniany przyciskami 24H/7D/30D/90D/Całość nad wykresem
let currentTimeframeDays = 30;

// Interwal punktow na wykresie w minutach (0 = "Auto" - dobierany do zakresu czasu).
// Backend dopisuje punkt co 5 min; przy wiekszym interwale punkty sa grupowane
// w przedzialy (np. co 1h) i z kazdego przedzialu bierzemy OSTATNI odczyt -
// tak jak "cena zamkniecia" na wykresach gieldowych. Wybor pamietany w przegladarce.
let currentIntervalMinutes = Number(localStorage.getItem('chart_interval_minutes')) || 0;

// Interwal dla trybu "Auto", zalezny od wybranego zakresu czasu
function autoIntervalFor(days) {
    if (days === 1) return 5;        // 24H -> co 5 min (wszystkie punkty)
    if (days === 7) return 60;       // 7D  -> co 1h
    if (days === 30) return 240;     // 30D -> co 4h
    return 1440;                     // 90D / Calosc -> co 1 dzien
}

// Grupuje punkty historii w przedzialy po `minutes` minut i z kazdego bierze ostatni.
// Przedzialy sa wyrownane do czasu LOKALNEGO (np. "co 1 dzien" = od polnocy u Ciebie,
// a nie od polnocy UTC).
function bucketHistory(history, minutes) {
    if (!minutes || minutes <= 5) return history;
    const size = minutes * 60 * 1000;
    const buckets = new Map();
    for (const point of history) {
        const ms = parseHistoryTimestamp(point.t);
        if (isNaN(ms)) continue;
        const localMs = ms - new Date(ms).getTimezoneOffset() * 60 * 1000;
        buckets.set(Math.floor(localMs / size), point); // pozniejszy punkt nadpisuje wczesniejszy
    }
    return Array.from(buckets.values());
}

// Backend zapisuje czas jako "YYYY-MM-DD HH:MM:SS" w UTC, bez litery T/strefy -
// doklejamy je, żeby Date sparsował to jako UTC, a nie lokalny czas przeglądarki.
function parseHistoryTimestamp(t) {
    const iso = String(t).includes('T') ? t : String(t).replace(' ', 'T') + 'Z';
    return new Date(iso).getTime();
}

// Ogranicza historię do punktów nie starszych niż `days` dni wstecz (0 = bez ograniczenia)
function filterHistoryByTimeframe(history, days) {
    if (!days || days <= 0) return history;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return history.filter(p => {
        const t = parseHistoryTimestamp(p.t);
        return isNaN(t) || t >= cutoff;
    });
}

// Ogranicza historię do maxPoints punktów (bierze co N-ty, zawsze zachowuje ostatni,
// żeby wykres zawsze kończył się na najświeższym odczycie)
function downsampleHistory(history, maxPoints) {
    if (history.length <= maxPoints) return history;
    const step = Math.ceil(history.length / maxPoints);
    const sampled = history.filter((_, i) => i % step === 0);
    const last = history[history.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled;
}

// Podmienia dane wykresu Chart.js na prawdziwą historię (zamiast statycznego [0, 0]) -
// najpierw przycina do wybranego zakresu czasu (currentTimeframeDays), potem downsampluje
function updatePerformanceChart(history) {
    if (!Array.isArray(history) || history.length === 0) return; // brak historii jeszcze - zostawiamy stan początkowy

    const inRange = filterHistoryByTimeframe(history, currentTimeframeDays);
    const interval = currentIntervalMinutes || autoIntervalFor(currentTimeframeDays);
    const bucketed = bucketHistory(inRange.length > 0 ? inRange : history, interval);
    const sampled = downsampleHistory(bucketed, HISTORY_CHART_MAX_POINTS);
    const labelFormat = interval >= 1440
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
    const labels = sampled.map(p => {
        const ms = parseHistoryTimestamp(p.t);
        const d = isNaN(ms) ? null : new Date(ms);
        return d ? d.toLocaleString('pl-PL', labelFormat) : '';
    });
    const values = sampled.map(p => Number(p.v) || 0);

    performanceChart.data.labels = labels;
    performanceChart.data.datasets[0].data = values;
    // Nowy zakres = nowy zoom - reset, żeby nie zostać "zoomniętym" w pusty fragment
    // po przełączeniu np. z 90D na 24H
    if (typeof performanceChart.resetZoom === 'function') performanceChart.resetZoom();
    performanceChart.update();
}

// --- PRZEŁĄCZNIK ZAKRESU CZASU (24H/7D/30D/90D/Całość) + RESET ZOOMU ---
document.querySelectorAll('#timeframe-selector .timeframe-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#timeframe-selector .timeframe-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTimeframeDays = Number(btn.dataset.days) || 0;
        updatePerformanceChart(currentPortfolioHistory);
    });
});

// --- PRZELACZNIK INTERWALU (Auto/5m/15m/30m/1h/4h/1D) ---
const intervalButtons = document.querySelectorAll('#interval-selector .timeframe-btn');
intervalButtons.forEach(btn => {
    // zaznaczamy przycisk zapamietany z poprzedniej wizyty
    btn.classList.toggle('active', (Number(btn.dataset.minutes) || 0) === currentIntervalMinutes);
    btn.addEventListener('click', () => {
        intervalButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentIntervalMinutes = Number(btn.dataset.minutes) || 0;
        localStorage.setItem('chart_interval_minutes', String(currentIntervalMinutes));
        updatePerformanceChart(currentPortfolioHistory);
    });
});

const resetZoomBtn = document.getElementById('reset-zoom-btn');
if (resetZoomBtn) {
    resetZoomBtn.addEventListener('click', () => {
        if (typeof performanceChart.resetZoom === 'function') performanceChart.resetZoom();
    });
}

// Liczy % zmiany aktualnej sumy portfela względem punktu z historii sprzed ~24h
// i podmienia tekst/kolor w #portfolio-growth (zamiast statycznego "↑ 0.0%")
function updatePortfolioGrowth(history, currentTotal) {
    const el = document.getElementById('portfolio-growth');
    if (!el) return;

    if (!Array.isArray(history) || history.length === 0) {
        el.innerText = 'Brak jeszcze historii do wyliczenia wzrostu.';
        el.style.color = 'var(--text-muted)';
        return;
    }

    // Szukamy ostatniego punktu, który jest starszy lub równy granicy "24h temu"
    // (czyli najbliższego jej od dołu) - jeśli cała historia jest krótsza niż 24h,
    // zostajemy przy najstarszym dostępnym punkcie i mówimy o tym wprost w tekście.
    const targetTime = Date.now() - GROWTH_LOOKBACK_MS;
    let reference = history[0];
    for (const point of history) {
        const t = parseHistoryTimestamp(point.t);
        if (isNaN(t)) continue;
        if (t <= targetTime) reference = point;
        else break;
    }

    const refValue = Number(reference.v) || 0;
    if (refValue <= 0) {
        el.innerText = 'Brak jeszcze historii do wyliczenia wzrostu.';
        el.style.color = 'var(--text-muted)';
        return;
    }

    const pct = ((currentTotal - refValue) / refValue) * 100;
    const arrow = pct >= 0 ? '↑' : '↓';
    const sign = pct >= 0 ? '+' : '';
    const oldestMs = parseHistoryTimestamp(history[0].t);
    const has24h = !isNaN(oldestMs) && (Date.now() - oldestMs) >= GROWTH_LOOKBACK_MS;

    el.innerText = `${arrow} ${sign}${pct.toFixed(1)}% w stosunku do ${has24h ? 'ostatnich 24h' : 'najstarszego dostępnego pomiaru'}`;
    el.style.color = pct >= 0 ? '#4ade80' : '#f85149';
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

// --- CENA ZAKUPU / ZYSK-STRATA ---
// Blockchain sam z siebie nie mówi po jakiej cenie coś kupiłeś (transfer na wallet to
// nie zawsze zakup - bywa swapem, airdropem, przelewem), więc cenę wpisuje się ręcznie,
// per pozycja (klucz = assetKey, tak samo jak przy "Ukryj"). Trzymane w overrides.json
// pod costBasis: { [assetKey]: { avgPriceUsd, dateAcquired } }.
function computePnl(asset) {
    const manual = currentOverrides.costBasis[assetKey(asset)];
    const cb = manual || asset.costBasis; // ręcznie wpisana cena zawsze wygrywa z auto-wykrytą
    if (!cb || !cb.avgPriceUsd) return null;

    const balance = Number(asset.balance) || 0;
    const valueUsd = Number(asset.valueUsd) || 0;
    const costUsd = cb.avgPriceUsd * balance;
    const pnlUsd = valueUsd - costUsd;
    const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : null;
    const daysHeld = cb.dateAcquired
        ? Math.max(0, Math.floor((Date.now() - new Date(cb.dateAcquired + 'T00:00:00Z').getTime()) / 86400000))
        : null;

    return { pnlUsd, pnlPct, daysHeld, avgPriceUsd: cb.avgPriceUsd, isAuto: !manual && cb.source === 'auto' };
}

// --- ROZWIJANA HISTORIA ZAKUPÓW ---
// Które wiersze są aktualnie rozwinięte (klucz = assetKey) - trzymane osobno od
// currentOverrides, bo to tylko stan UI tej sesji przeglądarki, nie zapisujemy tego.
let expandedAssetKeys = new Set();

// Rozwijalne są tylko pozycje z adresem kontraktu (zwykłe tokeny ERC-20) - tam ma sens
// i historia zakupów, i ręczne wskazanie pary Dexscreener. Natywne ETH, HL-PERP, saldo
// FOMO czy pozycje dodane ręcznie nie mają kontraktu, więc nie ma czego pokazywać.
function hasExpandableDetail(asset) {
    return !!asset.contract;
}

function toggleAssetExpand(key) {
    if (expandedAssetKeys.has(key)) expandedAssetKeys.delete(key);
    else expandedAssetKeys.add(key);
    renderDashboard();
}

// Buduje wiersz szczegółów (link Dexscreener + przycisk ręcznej pary + tabela
// pojedynczych zakupów z per-transakcyjnym zyskiem/stratą liczonym względem
// AKTUALNEJ ceny jednostkowej tej pozycji - to samo uproszczenie co reszta
// dashboardu: nie mamy cen historycznych, więc każda transakcja jest wyceniana
// dzisiejszą ceną, nie ceną z dnia sprzedaży.
function renderPurchaseDetailRow(asset, key) {
    const purchases = (asset.costBasis && Array.isArray(asset.costBasis.purchases)) ? asset.costBasis.purchases : [];
    const balance = Number(asset.balance) || 0;
    const currentUnitPrice = balance > 0 ? (Number(asset.valueUsd) || 0) / balance : null;

    const dexLinkHtml = asset.dexscreenerUrl
        ? `<a href="${escapeHtml(asset.dexscreenerUrl)}" target="_blank" rel="noopener" class="row-action-btn">Zobacz na Dexscreener ↗</a>`
        : '<span class="muted-note">Brak linku do Dexscreener</span>';

    const pairOverrideBtn = `<button class="row-action-btn" data-action="set-pair-override" data-contract="${escapeHtml(asset.contract)}" data-key="${escapeHtml(key)}">Ustaw parę ręcznie</button>`;

    let bodyHtml;
    if (purchases.length === 0) {
        bodyHtml = `<div class="muted-note" style="margin-top: 10px;">Brak automatycznie wykrytej historii zakupów dla tej pozycji.</div>`;
    } else {
        const rows = purchases.map(p => {
            const receivedAmount = Number(p.receivedAmount) || 0;
            const costUsd = Number(p.costUsd) || 0;
            const avgPriceUsd = Number(p.avgPriceUsd) || 0;
            const currentValue = currentUnitPrice !== null ? currentUnitPrice * receivedAmount : null;
            const pnlUsd = currentValue !== null ? currentValue - costUsd : null;
            const pnlPct = (pnlUsd !== null && costUsd > 0) ? (pnlUsd / costUsd) * 100 : null;

            const pnlHtml = pnlPct !== null
                ? `<span class="${pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnlUsd >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%${privacyMode ? '' : ` (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})`}</span>`
                : '<span class="muted-note">—</span>';

            const sourceLabel = p.source === 'fomo' ? 'FOMO' : (p.source === 'swap' ? 'Swap' : (p.source || '—'));
            const txShort = p.txHash ? `${p.txHash.slice(0, 10)}...` : '—';
            const txCell = p.explorerUrl
                ? `<a href="${escapeHtml(p.explorerUrl)}" target="_blank" rel="noopener">${escapeHtml(txShort)}</a>`
                : escapeHtml(txShort);

            return `
                <tr>
                    <td>${escapeHtml(p.date || '—')}</td>
                    <td>${money(receivedAmount.toFixed(4))}</td>
                    <td>$${avgPriceUsd.toFixed(6)}</td>
                    <td>${money(`$${costUsd.toFixed(2)}`)}</td>
                    <td>${pnlHtml}</td>
                    <td><span class="muted-note">${escapeHtml(sourceLabel)}</span></td>
                    <td>${txCell}</td>
                </tr>
            `;
        }).join('');

        bodyHtml = `
            <table class="purchase-history-table">
                <thead>
                    <tr><th>Data</th><th>Ilość</th><th>Cena/szt.</th><th>Koszt</th><th>Zysk/Strata</th><th>Źródło</th><th>Tx</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    return `
        <tr class="purchase-detail-row">
            <td colspan="8">
                <div class="purchase-detail-header">${dexLinkHtml}${pairOverrideBtn}</div>
                ${bodyHtml}
            </td>
        </tr>
    `;
}

// --- CENA JEDNOSTKOWA ---
// Liczona z tego, co już mamy: wartość USD / ilość (backend nie zapisuje ceny osobno).
function getUnitPrice(asset) {
    const balance = Number(asset.balance) || 0;
    const valueUsd = Number(asset.valueUsd) || 0;
    return balance > 0 ? valueUsd / balance : null;
}

// Formatowanie z liczbą miejsc dopasowaną do wielkości ceny - memecoiny kosztują
// ułamki centa, więc stałe 2 miejsca po przecinku pokazywałyby "$0.00".
function formatUnitPrice(price) {
    if (price === null || !isFinite(price)) return '<span class="muted-note">—</span>';
    if (price >= 1) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 0.01) return '$' + price.toFixed(4);
    if (price === 0) return '$0';
    const decimals = Math.min(18, -Math.floor(Math.log10(price)) + 3); // 4 cyfry znaczace, bez notacji 1e-7
    return '$' + price.toFixed(decimals);
}

// --- SORTOWANIE I SZUKAJKA ---
function sortValueFor(asset, column) {
    if (column === 'symbol') return String(asset.symbol || '').toLowerCase();
    if (column === 'balance') return Number(asset.balance) || 0;
    if (column === 'valueUsd') return Number(asset.valueUsd) || 0;
    if (column === 'unitPrice') {
        const p = getUnitPrice(asset);
        return p !== null ? p : -Infinity;
    }
    if (column === 'pnlPct') {
        const pnl = computePnl(asset);
        return pnl && pnl.pnlPct !== null ? pnl.pnlPct : -Infinity;
    }
    if (column === 'daysHeld') {
        const pnl = computePnl(asset);
        return pnl && pnl.daysHeld !== null ? pnl.daysHeld : -Infinity;
    }
    return 0;
}

function sortAssets(list) {
    const dir = sortDirection === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
        const va = sortValueFor(a, sortColumn);
        const vb = sortValueFor(b, sortColumn);
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
    });
}

function getSearchQuery() {
    const el = document.getElementById('asset-search');
    return el ? el.value.trim().toLowerCase() : '';
}

function matchesSearch(asset, query) {
    if (!query) return true;
    return (
        String(asset.symbol || '').toLowerCase().includes(query) ||
        String(asset.walletName || '').toLowerCase().includes(query) ||
        String(asset.network || '').toLowerCase().includes(query)
    );
}

// --- GRUPOWANIE PO PORTFELU ---
// Grupy posortowane od największej sumy do najmniejszej; pozycje WEWNĄTRZ każdej grupy
// sortowane wg aktualnie wybranej kolumny (sortColumn/sortDirection).
function groupAssetsByWallet(list) {
    const groups = {};
    list.forEach(asset => {
        const key = asset.walletName || 'Inne';
        if (!groups[key]) groups[key] = [];
        groups[key].push(asset);
    });

    return Object.entries(groups)
        .map(([walletName, assets]) => ({
            walletName,
            assets: sortAssets(assets),
            subtotal: assets.reduce((sum, a) => sum + (Number(a.valueUsd) || 0), 0)
        }))
        .sort((a, b) => b.subtotal - a.subtotal);
}

function updateSortArrows() {
    document.querySelectorAll('.sort-arrow').forEach(el => {
        const col = el.dataset.arrow;
        el.innerText = col === sortColumn ? (sortDirection === 'asc' ? '▲' : '▼') : '';
    });
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
        header.innerHTML = `<strong>${escapeHtml(ledger.label || key)}</strong><span>${money(`$${balance.toFixed(2)}`)}</span>`;
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
                <span>${escapeHtml(tx.date || '')} — ${escapeHtml(txTypeLabel(tx.type))} — ${money(`${sign}$${Math.abs(Number(tx.amountUsd) || 0).toFixed(2)}`)}${tx.note ? ' — ' + escapeHtml(tx.note) : ''}</span>
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

// Renderuje karty sum, tabelę assetów (pogrupowaną po portfelu, sortowalną) i panele
// (ukryte pozycje, ledgery) na podstawie currentPortfolioData + currentOverrides.
// Wywoływane po każdym załadowaniu danych ORAZ po każdej zmianie (ukrycie/przywrócenie/
// dodanie ręczne/zmiana ledgera/zmiana sortowania/wpisanie w szukajkę/ustawienie ceny).
function renderDashboard() {
    // Suma liczona z WSZYSTKICH widocznych assetów (bez filtra szukajki - suma portfela
    // nie powinna skakać, kiedy tylko coś wpisujesz w polu wyszukiwania) + sald ledgerów
    const allVisible = getVisibleAssets();
    const assetsTotal = allVisible.reduce((sum, a) => sum + (Number(a.valueUsd) || 0), 0);
    const total = assetsTotal + getLedgersTotal();
    lastComputedTotal = total;
    const totalFormatted = money(`$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    document.getElementById('total-portfolio-value').innerText = totalFormatted;
    document.getElementById('total-wealth').innerText = totalFormatted;

    const query = getSearchQuery();
    const filtered = allVisible.filter(a => matchesSearch(a, query));
    const groups = groupAssetsByWallet(filtered);

    // Alokacja per portfel liczona z WSZYSTKICH widocznych assetów (bez filtra szukajki,
    // z tego samego powodu co suma portfela wyżej) - osobne grupowanie, bo `groups` powyżej
    // jest już przefiltrowane i służy tylko do rysowania tabeli.
    updateAllocationChart(groupAssetsByWallet(allVisible));

    const tbody = document.getElementById('assets-table-body');
    tbody.innerHTML = '';

    if (groups.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Brak aktywnych aktywów${query ? ' pasujących do szukania' : ''}</td></tr>`;
    } else {
        groups.forEach(group => {
            const headerRow = document.createElement('tr');
            headerRow.className = 'group-header-row';
            headerRow.innerHTML = `<td colspan="8"><strong>${escapeHtml(group.walletName)}</strong> — ${money(`$${group.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}</td>`;
            tbody.appendChild(headerRow);

            group.assets.forEach(asset => {
                const row = document.createElement('tr');
                const balance = Number(asset.balance) || 0;
                const valueUsd = Number(asset.valueUsd) || 0;
                const pnl = computePnl(asset);
                const key = assetKey(asset);
                const expandable = hasExpandableDetail(asset);
                const isExpanded = expandable && expandedAssetKeys.has(key);

                let pnlCell = '<span class="muted-note">—</span>';
                if (pnl && pnl.pnlPct !== null) {
                    const cls = pnl.pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg';
                    const sign = pnl.pnlUsd >= 0 ? '+' : '';
                    const autoTag = pnl.isAuto ? ' <span class="muted-note">(auto)</span>' : '';
                    pnlCell = `<span class="${cls}">${sign}${pnl.pnlPct.toFixed(1)}%${privacyMode ? '' : ` (${sign}$${pnl.pnlUsd.toFixed(2)})`}</span>${autoTag}`;
                }
                const daysCell = pnl && pnl.daysHeld !== null ? pnl.daysHeld : '<span class="muted-note">—</span>';

                const actionCell = `
                    <button class="row-action-btn" data-action="set-cost-basis" data-key="${escapeHtml(key)}">Cena zakupu</button>
                    ${asset.isManual
                        ? `<button class="row-action-btn" data-action="remove-manual" data-id="${escapeHtml(asset.id)}">Usuń</button>`
                        : `<button class="row-action-btn" data-action="hide" data-key="${escapeHtml(key)}">Ukryj</button>`}
                `;

                const chevron = expandable ? `<span class="expand-chevron">${isExpanded ? '▾' : '▸'}</span> ` : '';

                row.className = 'asset-row' + (expandable ? ' asset-row-expandable' : '');
                if (expandable) row.dataset.key = key;

                row.innerHTML = `
                    <td>${chevron}<strong>${escapeHtml(asset.symbol)}</strong>${asset.isManual ? ' <span class="manual-badge">ręcznie</span>' : ''}</td>
                    <td>${escapeHtml(asset.network)}</td>
                    <td>${money(balance.toFixed(4))}</td>
                    <td>${formatUnitPrice(getUnitPrice(asset))}</td>
                    <td>${money(`$${valueUsd.toFixed(2)}`)}</td>
                    <td>${pnlCell}</td>
                    <td>${daysCell}</td>
                    <td>${actionCell}</td>
                `;
                tbody.appendChild(row);

                if (isExpanded) {
                    tbody.insertAdjacentHTML('beforeend', renderPurchaseDetailRow(asset, key));
                }
            });
        });
    }

    updateSortArrows();
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

// Obsługa kliknięć w tabeli assetów (przyciski "Ukryj" / "Usuń" / "Cena zakupu") —
// delegacja zdarzeń, żeby nie podpinać osobnego listenera do każdego wiersza przy każdym renderze
document.getElementById('assets-table-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
        if (btn.dataset.action === 'hide') hideAsset(btn.dataset.key);
        if (btn.dataset.action === 'remove-manual') removeManualAsset(btn.dataset.id);
        if (btn.dataset.action === 'set-cost-basis') openCostBasisForm(btn.dataset.key);
        if (btn.dataset.action === 'set-pair-override') openPairOverrideForm(btn.dataset.contract, btn.dataset.key);
        return;
    }

    // Klik gdziekolwiek indziej w wierszu (nie w przycisk, nie w link wewnątrz
    // rozwiniętych szczegółów) rozwija/zwija historię zakupów tej pozycji
    const row = e.target.closest('tr.asset-row-expandable');
    if (row && row.dataset.key) {
        toggleAssetExpand(row.dataset.key);
    }
});

// Sortowanie klikiem w nagłówek kolumny - ponowny klik w tę samą kolumnę odwraca kierunek
document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortColumn === col) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            sortColumn = col;
            sortDirection = 'desc';
        }
        renderDashboard();
    });
});

// Szukajka - filtruje tabelę na bieżąco, nie wpływa na sumę portfela (patrz renderDashboard)
const assetSearchInput = document.getElementById('asset-search');
if (assetSearchInput) {
    assetSearchInput.addEventListener('input', () => renderDashboard());
}

// --- FORMULARZ "Cena zakupu" ---
let costBasisTargetKey = null;

function openCostBasisForm(key) {
    costBasisTargetKey = key;
    const [symbol, walletName] = key.split('::');
    document.getElementById('cost-basis-target-label').innerText = `${symbol} (${walletName})`;

    const manual = currentOverrides.costBasis[key];
    const asset = getVisibleAssets().find(a => assetKey(a) === key);
    const auto = asset ? asset.costBasis : null;
    const existing = manual || auto;

    document.getElementById('cost-basis-price').value = existing ? existing.avgPriceUsd : '';
    document.getElementById('cost-basis-date').value = existing ? existing.dateAcquired : '';
    document.getElementById('cost-basis-error').innerText = manual
        ? ''
        : (auto ? 'Cena wykryta automatycznie (z zakupu na chainie) - zmień i zapisz, żeby nadpisać ręcznie.' : '');

    document.getElementById('cost-basis-form').style.display = 'flex';
}

document.getElementById('cost-basis-cancel-btn').addEventListener('click', () => {
    document.getElementById('cost-basis-form').style.display = 'none';
    costBasisTargetKey = null;
});

document.getElementById('cost-basis-save-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('cost-basis-error');
    const priceRaw = document.getElementById('cost-basis-price').value.trim();
    const date = document.getElementById('cost-basis-date').value;

    if (!priceRaw || isNaN(Number(priceRaw)) || Number(priceRaw) <= 0) {
        errorEl.innerText = 'Podaj poprawną cenę (> 0).';
        return;
    }
    if (!costBasisTargetKey) return;

    currentOverrides.costBasis[costBasisTargetKey] = {
        avgPriceUsd: Number(priceRaw),
        dateAcquired: date || new Date().toISOString().substring(0, 10)
    };

    document.getElementById('cost-basis-form').style.display = 'none';
    costBasisTargetKey = null;
    renderDashboard();
    scheduleSave();
});

document.getElementById('cost-basis-clear-btn').addEventListener('click', async () => {
    if (!costBasisTargetKey) return;
    delete currentOverrides.costBasis[costBasisTargetKey];
    document.getElementById('cost-basis-form').style.display = 'none';
    costBasisTargetKey = null;
    renderDashboard();
    scheduleSave();
});

// --- FORMULARZ "Ustaw parę ręcznie" (priceOverrides) ---
// Pozwala ręcznie wkleić link do konkretnej pary na Dexscreener, żeby nadpisać
// automatyczne wyszukiwanie (przydatne gdy auto-wykrywanie trafia na złą/za płytką
// parę). Klucz w overrides.json to adres KONTRAKTU (nie assetKey), bo cena dotyczy
// tokena jako takiego, niezależnie od tego w którym portfelu go trzymasz.
let pairOverrideTargetContract = null;

function openPairOverrideForm(contract, key) {
    pairOverrideTargetContract = contract;
    const asset = getVisibleAssets().find(a => assetKey(a) === key);
    document.getElementById('pair-override-target-label').innerText = asset ? `${asset.symbol} (${asset.walletName})` : contract;

    const existing = currentOverrides.priceOverrides ? currentOverrides.priceOverrides[contract] : null;
    document.getElementById('pair-override-url').value = existing || '';
    document.getElementById('pair-override-error').innerText = '';

    document.getElementById('pair-override-form').style.display = 'flex';
}

document.getElementById('pair-override-cancel-btn').addEventListener('click', () => {
    document.getElementById('pair-override-form').style.display = 'none';
    pairOverrideTargetContract = null;
});

document.getElementById('pair-override-save-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('pair-override-error');
    const url = document.getElementById('pair-override-url').value.trim();

    if (!url) {
        errorEl.innerText = 'Wklej link do pary na Dexscreener.';
        return;
    }
    if (!/^https:\/\/dexscreener\.com\/[^/]+\/0x[a-fA-F0-9]+/.test(url)) {
        errorEl.innerText = 'To nie wygląda na link do pary Dexscreener (oczekiwany format: https://dexscreener.com/siec/0xadrespary).';
        return;
    }
    if (!pairOverrideTargetContract) return;

    if (!currentOverrides.priceOverrides) currentOverrides.priceOverrides = {};
    currentOverrides.priceOverrides[pairOverrideTargetContract] = url;

    document.getElementById('pair-override-form').style.display = 'none';
    pairOverrideTargetContract = null;
    renderDashboard();
    scheduleSave();
});

document.getElementById('pair-override-clear-btn').addEventListener('click', async () => {
    if (!pairOverrideTargetContract) return;
    if (currentOverrides.priceOverrides) delete currentOverrides.priceOverrides[pairOverrideTargetContract];
    document.getElementById('pair-override-form').style.display = 'none';
    pairOverrideTargetContract = null;
    renderDashboard();
    scheduleSave();
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
    // (np. gdy poprzednie pobranie jeszcze trwa przy wolnym łączu)
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
            currentOverrides = overridesRes.ok ? await overridesRes.json() : { hidden: [], manual: [], ledgers: {}, costBasis: {}, priceOverrides: {} };
        } catch (e) {
            currentOverrides = { hidden: [], manual: [], ledgers: {}, costBasis: {}, priceOverrides: {} };
        }
        if (!Array.isArray(currentOverrides.hidden)) currentOverrides.hidden = [];
        if (!Array.isArray(currentOverrides.manual)) currentOverrides.manual = [];
        if (!currentOverrides.ledgers || typeof currentOverrides.ledgers !== 'object') currentOverrides.ledgers = {};
        if (!currentOverrides.costBasis || typeof currentOverrides.costBasis !== 'object') currentOverrides.costBasis = {};
        if (!currentOverrides.priceOverrides || typeof currentOverrides.priceOverrides !== 'object') currentOverrides.priceOverrides = {};

        // portfolio-history.json może jeszcze nie istnieć (przed pierwszym uruchomieniem
        // workflow po wgraniu tej zmiany) — brak pliku to normalny stan, nie błąd
        try {
            const historyRes = await fetch(`portfolio-history.json?t=${Date.now()}`);
            currentPortfolioHistory = historyRes.ok ? await historyRes.json() : [];
            if (!Array.isArray(currentPortfolioHistory)) currentPortfolioHistory = [];
        } catch (e) {
            currentPortfolioHistory = [];
        }

        // Backend zapisuje timestamp w UTC ("YYYY-MM-DD HH:MM:SS", bez strefy) -
        // przeliczamy go na czas lokalny przeglądarki (tak samo jak wykres), zamiast
        // wyświetlać surowy UTC. 'sv-SE' daje format RRRR-MM-DD GG:MM:SS.
        const updatedMs = parseHistoryTimestamp(currentPortfolioData.timestamp);
        const updatedLabel = isNaN(updatedMs)
            ? currentPortfolioData.timestamp
            : new Date(updatedMs).toLocaleString('sv-SE');
        document.getElementById('last-update').innerText = `Ostatnia aktualizacja danych: ${updatedLabel}`;

        renderDashboard();
        updatePerformanceChart(currentPortfolioHistory);
        updatePortfolioGrowth(currentPortfolioHistory, lastComputedTotal);

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

// --- PRZYCISK TRYBU PRYWATNEGO ---
const privacyBtn = document.getElementById('privacy-toggle-btn');
function updatePrivacyButton() {
    if (!privacyBtn) return;
    privacyBtn.innerText = privacyMode ? 'Pokaż kwoty' : 'Ukryj kwoty';
    privacyBtn.classList.toggle('active', privacyMode);
}
if (privacyBtn) {
    updatePrivacyButton();
    privacyBtn.addEventListener('click', () => {
        privacyMode = !privacyMode;
        localStorage.setItem('privacy_mode', privacyMode ? '1' : '0');
        updatePrivacyButton();
        if (currentPortfolioData) renderDashboard();
        performanceChart.update(); // przerysowanie osi Y
    });
}
