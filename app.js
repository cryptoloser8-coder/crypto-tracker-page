// app.js

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

// Główna funkcja pobierająca i renderująca dane portfela
async function loadPortfolioData() {
    try {
        // Dodajemy parametr czasu (?t=...), aby przeglądarka nie pobierała starej wersji z pamięci podręcznej (cache)
        const response = await fetch(`portfolio-data.json?t=${new Date().getTime()}`);
        if (!response.ok) throw new Error('Brak pliku danych');
        
        const data = await response.json();
        
        document.getElementById('total-portfolio-value').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('total-wealth').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('last-update').innerText = `Ostatnia aktualizacja: ${data.timestamp}`;

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

    } catch (error) {
        console.log("Czekam na wygenerowanie pliku portfolio-data.json...");
    }
}

// OBSŁUGA PRZYCISKU ODŚWIEŻANIA NA STRONIE
// (Upewnij się, że w HTML masz przycisk z ID "refresh-btn")
const refreshBtn = document.getElementById('refresh-btn');
if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.innerText = 'Odświeżanie...';
        await loadPortfolioData();
        refreshBtn.innerText = 'Odśwież dane';
    });
}
