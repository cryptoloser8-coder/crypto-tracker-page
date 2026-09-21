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

// Funkcja pobierająca dane z pliku portfolio-data.json
async function loadPortfolioData() {
    try {
        const response = await fetch('portfolio-data.json');
        if (!response.ok) throw new Error('Brak pliku danych');
        
        const data = await response.json();
        
        // Aktualizacja interfejsu
        document.getElementById('total-portfolio-value').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('total-wealth').innerText = `$${data.totalUsd.toLocaleString()}`;
        document.getElementById('last-update').innerText = `Ostatnia aktualizacja: ${data.timestamp}`;

        // Wypełnienie tabeli tokenów
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
        console.log("Czekam na wygenerowanie pliku portfolio-data.json przez backend...");
    }
}

loadPortfolioData();
