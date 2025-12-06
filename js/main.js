import { DashPlayer } from './dash-player.js';
import { PlayerUI } from './ui.js';

const SERVER = 'http://localhost:8080';
const video = document.getElementById('video');

// Inicialização
const ui = new PlayerUI(null); // Instancia UI primeiro para ter acesso ao log

const player = new DashPlayer(
    video,
    SERVER,
    (msg, ...args) => {
        const text = [msg, ...args].map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        ui.log(text);
    },
    (stats) => ui.updateStats(stats)
);

// Conecta UI ao Player
ui.player = player;

// Inicializa lista de qualidades assim que possível
(async () => {
    try {
        const qualities = await player.fetchManifest();
        ui.populateQualitySelect(qualities, player.currentQualityIndex);
    } catch (e) {
        ui.log('Aviso: não foi possível buscar manifest no início. Inicie o servidor e clique em Iniciar. ' + e.message);
    }
})();

// Expor para debug
window._player = player;
