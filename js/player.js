import { initVodBuffer } from './vod-buffer.js';

const $ = sel => document.querySelector(sel);
const video = $('#video');
const playPause = $('#playPause');
const progress = $('#progress');
const timeLabel = $('#time');
const muteBtn = $('#mute');
const fsBtn = $('#fs');

// Inicializa o buffer VoD
initVodBuffer(video, 'sample.mp4');


// Formata segundos -> mm:ss
function formatTime(s) {
    if (!isFinite(s)) return '00:00';
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}


// Atualiza rótulos e barra
function updateProgress() {
    const current = video.currentTime;
    const dur = video.duration || 0;
    progress.max = dur;
    progress.value = current;
    timeLabel.textContent = `${formatTime(current)} / ${formatTime(dur)}`;
}


// Toggle play/pause
function togglePlay() {
    if (video.paused || video.ended) {
        video.play();
    } else {
        video.pause();
    }
}


// Atualiza botão de play
video.addEventListener('play', () => playPause.textContent = '⏸️');
video.addEventListener('pause', () => playPause.textContent = '▶️');


// Sincronia progress bar enquanto toca
video.addEventListener('timeupdate', updateProgress);
video.addEventListener('loadedmetadata', updateProgress);
video.addEventListener('ended', () => { progress.value = progress.max; });


// Interações
playPause.addEventListener('click', togglePlay);
video.addEventListener('dblclick', () => {
    // duplo clique para alternar tela cheia
    if (document.fullscreenElement) document.exitFullscreen();
    else video.requestFullscreen();
});


progress.addEventListener('input', (e) => {
    // seeker ao arrastar
    video.currentTime = parseFloat(e.target.value);
});


muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
});


fsBtn.addEventListener('click', () => {
    const el = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});


// Teclas de atalho
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowRight':
            video.currentTime = Math.min((video.currentTime || 0) + 5, video.duration || 0);
            break;
        case 'ArrowLeft':
            video.currentTime = Math.max((video.currentTime || 0) - 5, 0);
            break;
        case 'm':
        case 'M':
            video.muted = !video.muted;
            muteBtn.textContent = video.muted ? '🔇' : '🔊';
            break;
        case 'f':
        case 'F':
            if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
            break;
    }
});


// Melhorar acessibilidade: foco no vídeo ao carregar
window.addEventListener('load', () => {
    video.setAttribute('tabindex', '0');
});
