export function log(msg, type = 'info') {
    const consoleEl = document.getElementById('logConsole');
    if (!consoleEl) { console.log(`[${type}] ${msg}`); return; }
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleEl.prepend(entry);
}

export function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function parseISODuration(pt) {
    // Regex simplificado para pegar Horas, Minutos, Segundos
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const matches = pt.match(regex);
    if (!matches) return 0;

    const h = parseFloat(matches[1] || 0);
    const m = parseFloat(matches[2] || 0);
    const s = parseFloat(matches[3] || 0);

    return (h * 3600) + (m * 60) + s;
}
