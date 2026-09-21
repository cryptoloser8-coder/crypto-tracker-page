// app.js

// --- STAN GLOBALNY (musi być zadeklarowany na samej górze) ---
// Uwaga: te zmienne MUSZĄ być zadeklarowane przed jakimkolwiek wywołaniem
// unlockDashboard()/loadPortfolioData() poniżej — inaczej JS rzuci
// "ReferenceError: Cannot access ... before initialization" (TDZ dla let/const),
// bo kod niżej (savedToken -> unlockDashboard) wykonuje się już przy starcie skryptu.
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000; // co ile automatycznie sprawdzamy dane (ms)
let autoRefreshTimer = null;
let isRefreshing = false; // zabezpieczenie przed nakładającymi się requestami

// Sprawdzamy, czy token jest już zapamiętany w przeglądarce
const savedToken = localStorage.getItem('portfolio_auth_token');
if (savedToken) {
    unlockDashboard(savedToken);
}

document.getElementById('auth-btn').addEventListener('click', () => {
    const token = document.getElementById('token-input').value.trim();
    if (!token) {
        showError('Wpisz token!');
        return;
    }
    unlockDashboard(token);
});

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
// (Upewnij się, że w HTML masz przycisk z ID "refresh-btn")
const refreshBtn = document.getElementById('refresh-btn');
if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
        if (isRefreshing) return; // klik ignorowany, gdy refresh już trwa (np. z auto-odświeżania)
        refreshBtn.disabled = true;
        refreshBtn.innerText = 'Odświeżanie...';
        await loadPortfolioData();
        refreshBtn.disabled = false;
        refreshBtn.innerText = 'Odśwież dane';
    });
}
